//! T5 — El arsenal: las cuatro herramientas del boss y el ataque del jugador.
//!
//! **Cada ataque se resuelve en un solo tick**, el de entrada a la fase activa.
//! Eso evita tener que llevar un "ya golpeó" en el estado del mundo, y hace que
//! acierto y whiff se decidan en el mismo instante — que es la señal de
//! aprendizaje que le importa al bandit.
//!
//! La contrapartida: el hitbox es el barrido completo del ataque, no su forma
//! instante a instante. Para la embestida eso es *más* honesto (el decal marca
//! todo el recorrido); para la onda significa que el radio creciente es
//! telegrafía y el golpe cae al final. Lo que se dibuja es lo que golpea.

use crate::actor::{self, Frames};
use crate::collision::closest_on_aabb;
use crate::types::{
    ActId, Actor, Event, PlayerAction, Projectile, Shape, Side, StepEvents, ToolId, Vec2, World, DT,
};

// --- Perillas de calibración -------------------------------------------------

/// Alcance del arco del martillo y semiapertura, en radianes.
pub const HAMMER_REACH: f32 = 3.2;
pub const HAMMER_ARC: f32 = 0.9;

pub const CANNON_SPEED: f32 = 18.0;
pub const CANNON_RADIUS: f32 = 0.35;
pub const CANNON_TTL: u16 = 120;
/// Largo de la línea de tiro que se telegrafía. No es el alcance real —el
/// proyectil vuela hasta chocar— sino hasta dónde se marca la dirección: un
/// decal que cruce la arena entera tapa el mapa en vez de informar.
pub const CANNON_TELL: f32 = 12.0;

/// La onda es lo único que el parámetro dimensiona en distancia, no en ángulo.
pub const WAVE_MIN_R: f32 = 3.0;
pub const WAVE_MAX_R: f32 = 8.0;

pub const CHARGE_DASH: f32 = 45.0;
pub const CHARGE_WIDTH: f32 = 1.8;
/// Distancia real que recorre la embestida con `CHARGE_DASH` y la fricción de
/// `actor::DAMP`. Es el largo del decal, así que tiene que coincidir con la
/// simulación: `embestida_recorre_lo_que_telegrafia` lo verifica.
pub const CHARGE_REACH: f32 = 4.2;

/// El cañón del jugador (`PlayerAction::Ability`). Su respuesta a distancia.
///
/// **La velocidad sale de una desigualdad, no del gusto.** El boss anda a 4.5 y
/// necesita 1.2 unidades de desplazamiento lateral —su radio más el del
/// proyectil— para salirse del corredor: son 16 ticks. Para que esquivar sea
/// una *decisión* y no un trámite, el vuelo tiene que durar aproximadamente
/// eso: si dura mucho más, el boss se aparta sin siquiera intentarlo; si dura
/// mucho menos, no hay nada que decidir.
///
/// A 26 u/s, un disparo a ocho unidades vuela 18 ticks contra los 16 que el
/// boss necesita: el que reacciona a tiempo se salva por poco y el que no,
/// se lo come. Ése es exactamente el margen que queremos.
///
/// Estuvo en 14, y a esa velocidad **el arma no existía**: medido sobre 400
/// peleas, 400 disparos y **cero impactos**, con la puntería perfecta (0.0° de
/// error medio). El vuelo duraba 1.7 s y al boss le sobraba con caminar. Un
/// arma que nunca amenaza deja sin ejercitar todo el subsistema de esquiva, así
/// que el boss tampoco podía aprender nada sobre ella.
pub const PLAYER_CANNON_SPEED: f32 = 26.0;
pub const PLAYER_CANNON_RADIUS: f32 = 0.3;
/// ~37 unidades de vuelo: cruza la arena.
pub const PLAYER_CANNON_TTL: u16 = 160;
/// El mismo daño que tenía el espadazo al que reemplaza, para no mover dos
/// cosas a la vez: cambia el alcance, no la economía. Con su cooldown de 180
/// son 7.3 de daño por segundo contra los 22.5 del ataque básico — el cañón no
/// es la fuente de daño, es la herramienta de cuando no podés acercarte.
pub const PLAYER_CANNON_DAMAGE: i32 = 22;
/// Largo del decal de telegrafía, igual que [`CANNON_TELL`].
pub const PLAYER_CANNON_TELL: f32 = 12.0;

pub const PLAYER_REACH: f32 = 1.9;
pub const PLAYER_ARC: f32 = 0.8;

/// Frame data de cada herramienta. Windups largos y visibles: el boss telegrafía
/// siempre (principio 2 de CLAUDE.md).
///
/// Los cooldowns son largos a propósito: el boss ataca poco y deja huecos para
/// pegarle. La dificultad tiene que venir de la política —qué herramienta saca
/// y cuándo— y no de la cadencia; si sube por cadencia, el jugador lo huele.
///
/// La tabla **no puede depender del cerebro**: el verificador re-simula el log
/// sin blob, así que unos frames que cambiaran con la maestría harían rechazar
/// peleas legítimas.
pub fn frames(t: ToolId) -> Frames {
    match t {
        ToolId::Hammer => Frames::attack(26, 4, 22, 150),
        ToolId::Cannon => Frames::attack(20, 2, 16, 240),
        ToolId::Wave => Frames::attack(34, 3, 26, 330),
        ToolId::Charge => Frames {
            dash: CHARGE_DASH,
            ..Frames::attack(22, 10, 24, 300)
        },
        // `iframes > 0` es lo que la convierte en esquiva: `actor::try_start`
        // la manda directa a `Dodging` sin windup y sin telegrafía, igual que
        // la del jugador — una esquiva es reacción, y una reacción anunciada no
        // es una reacción.
        //
        // El cooldown es **el** coste: 5 segundos contra un cañón del jugador
        // que sale cada 3, así que no puede esquivar todos. Por eso mismo el
        // dash **no** dispara `RESPIRO` (ver [`begin`]): si además le costara el
        // arsenal entero, esquivar sería siempre peor que comerse el golpe y el
        // brazo nacería muerto.
        ToolId::Dash => Frames {
            windup: 0,
            active: 20,
            recovery: 0,
            cooldown: DASH_COOLDOWN,
            dash: DASH_IMPULSO,
            iframes: 14,
        },
    }
}

/// Cooldown del dash del boss, en ticks. 5 segundos: el cañón del jugador sale
/// cada 3, así que **no le alcanza para esquivarlos todos**, que es la
/// condición para que elegir cuál esquivar signifique algo.
pub const DASH_COOLDOWN: u16 = 300;
/// Impulso del dash. Con la fricción de `actor::DAMP` y sus 20 ticks activos,
/// **desplaza ~3.3 unidades**: unos tres radios y medio del boss, que es lo que
/// hace falta para que se lea como una esquiva y no como un paso al costado.
///
/// Estuvo en 16 (1.6 unidades) hasta que se vio en pantalla que no se notaba,
/// y por dos razones a la vez: era corto **y** `actor::apply_move` lo clampeaba
/// a `BOSS_MAX_SPEED`, o sea a la velocidad de caminar. Arreglado el clamp, el
/// número quedó como la única perilla.
///
/// Queda por debajo de la embestida (`CHARGE_DASH`, ~3.6): esquivar no debería
/// cubrir más terreno que el ataque que sirve para cerrar distancia.
pub const DASH_IMPULSO: f32 = 34.0;

/// La tabla del boss como `actor::Table`.
pub fn boss_table(act: ActId) -> Frames {
    debug_assert!(ToolId::from_u8(act.0).is_some(), "slot fuera de rango");
    frames(ToolId::from_u8(act.0).unwrap_or(ToolId::Hammer))
}

/// Después de cualquier ataque, **todo el arsenal queda frío** este mínimo.
///
/// Sin esto los cuatro cooldowns corren independientes y siempre hay alguno en
/// cero: medido sobre 100 peleas con el boss ya entrenado, el hueco entre
/// ataques tenía mediana 64 ticks y p10 **53**, que es exactamente la animación
/// completa del martillo. O sea que el boss no elegía el momento — atacaba tan
/// rápido como su cuerpo se lo permitía, y la premisa de "ataca poco y deja
/// huecos para pegarle" se cayó en cuanto tuvo cuatro herramientas.
///
/// Es cadencia, y la cadencia no es la perilla de dificultad: por eso es
/// **fija**, no depende del cerebro ni de la maestría, y el verificador la
/// aplica igual al re-simular. Lo que compra es que gastar una herramienta
/// ahora **cueste las otras tres**, que es la condición para que "elegir el
/// momento" signifique algo — sin costo, la mejor jugada es siempre atacar y no
/// hay política que aprender.
pub const RESPIRO: u16 = 90;

/// Hasta dónde llega cada herramienta, medido desde el centro del boss en el
/// momento en que el golpe se resuelve.
///
/// Es lo que convierte "no vale la pena atacar sin alcance" en una decisión
/// del cerebro en vez de algo que la política tenga que
/// redescubrir contexto por contexto a fuerza de whiffs. El cañón es el único
/// que no tiene alcance de diseño: el suyo es cuánto vuela antes de agotarse.
pub fn reach(t: ToolId) -> f32 {
    match t {
        ToolId::Hammer => HAMMER_REACH,
        ToolId::Cannon => CANNON_SPEED * CANNON_TTL as f32 * DT,
        ToolId::Wave => WAVE_MAX_R,
        ToolId::Charge => CHARGE_REACH,
        // El dash no alcanza nada.
        ToolId::Dash => f32::INFINITY,
    }
}

pub fn damage(t: ToolId) -> i32 {
    match t {
        ToolId::Hammer => 22,
        ToolId::Cannon => 14,
        ToolId::Wave => 18,
        ToolId::Charge => 26,
        ToolId::Dash => 0,
    }
}

/// El parámetro de bajo nivel es un ángulo para todas menos la onda, donde es
/// el radio. Es lo que el modelo aprende a afinar; arranca siendo ruido, y por
/// eso el boss del día 1 pega a 40° del jugador.
pub fn param_is_angle(t: ToolId) -> bool {
    // Para el dash el parámetro es la dirección del impulso, no la del golpe.
    !matches!(t, ToolId::Wave)
}

/// ¿La herramienta hace daño? El dash no: no tiene hitbox, no telegrafía, no
/// dispara [`RESPIRO`] y no se resuelve en `ToActive`.
pub fn damaging(t: ToolId) -> bool {
    t != ToolId::Dash
}

/// Área afectada. La misma forma para el hitbox y para el decal: si el decal
/// mintiera, el boss se sentiría injusto por más que telegrafíe.
pub fn hitbox(t: ToolId, origin: Vec2, param: f32) -> Shape {
    match t {
        ToolId::Hammer => Shape::Arc {
            c: origin,
            r: HAMMER_REACH,
            facing: param,
            half_angle: HAMMER_ARC,
        },
        ToolId::Wave => Shape::Circle {
            c: origin,
            r: param.max(WAVE_MIN_R).min(WAVE_MAX_R),
        },
        ToolId::Charge => {
            let dir = Vec2::from_angle(param);
            Shape::Rect {
                c: origin.add(dir.scale(CHARGE_REACH * 0.5)),
                half: Vec2::new(CHARGE_REACH * 0.5, CHARGE_WIDTH * 0.5),
                facing: param,
            }
        }
        // El cañón no golpea al dispararse: lo que se marca es por dónde va a
        // pasar el proyectil, que es exactamente lo que el jugador necesita
        // para apartarse o meter una pared en medio.
        ToolId::Cannon => {
            let dir = Vec2::from_angle(param);
            Shape::Rect {
                c: origin.add(dir.scale(CANNON_TELL * 0.5)),
                half: Vec2::new(CANNON_TELL * 0.5, CANNON_RADIUS),
                facing: param,
            }
        }
        // El dash no golpea. Nunca se pide —`begin` no telegrafía lo que no
        // hace daño— y devolver un círculo nulo es más barato que un `Option`
        // que todos los llamadores tendrían que desenvolver.
        ToolId::Dash => Shape::Circle { c: origin, r: 0.0 },
    }
}

/// ¿La forma toca un círculo? Sin trigonometría: todo sale de productos punto.
pub fn hits(s: &Shape, p: Vec2, radius: f32) -> bool {
    match *s {
        Shape::Circle { c, r } => c.dist_sq(p) <= (r + radius) * (r + radius),

        Shape::Arc {
            c,
            r,
            facing,
            half_angle,
        } => {
            let to = p.sub(c);
            let reach = r + radius;
            if to.len_sq() > reach * reach {
                return false;
            }
            // El radio del blanco se cobra en el alcance, no en el ángulo: un
            // arco que roza el borde cuenta como acierto.
            to.normalized().dot(Vec2::from_angle(facing)) >= libm::cosf(half_angle)
        }

        Shape::Rect { c, half, facing } => {
            let dir = Vec2::from_angle(facing);
            let to = p.sub(c);
            let local = Vec2::new(to.dot(dir), to.dot(dir.perp()));
            let d = Vec2::new(
                (local.x.abs() - half.x).max(0.0),
                (local.y.abs() - half.y).max(0.0),
            );
            d.len_sq() <= radius * radius
        }
    }
}

/// Punto de entrada del boss: apunta, arranca la acción y **emite la
/// telegrafía**. Que sea la única puerta es lo que hace imposible olvidarla.
pub fn begin(boss: &mut Actor, t: ToolId, param: f32, ev: &mut StepEvents) -> bool {
    if !actor::try_start(boss, t.act(), param, frames(t)) {
        return false;
    }
    // Esquivar no gasta el arsenal: su precio es su propio cooldown de 5
    // segundos. Cobrarle además `RESPIRO` haría que esquivar costara siempre
    // más que el golpe que evita, y el brazo no se elegiría nunca.
    if damaging(t) {
        for (i, c) in boss.cooldowns.iter_mut().enumerate() {
            // El dash queda fuera del respiro en los dos sentidos: no lo
            // dispara y **no lo sufre**. `RESPIRO` existe para que gastar un
            // arma cueste las otras tres, y esquivar no es un arma — si atacar
            // dejara la esquiva fría 90 ticks, el boss no podría reaccionar
            // nunca mientras el arsenal se enfría, que es justo cuando está
            // expuesto. Medido: con el dash dentro del respiro, se usaba el 0%
            // de las veces aunque hubiera 36 ticks de amenaza por pelea.
            if i != ToolId::Dash as usize {
                *c = (*c).max(RESPIRO);
            }
        }
    }
    if param_is_angle(t) {
        boss.facing = param;
    }
    // Lo que no hace daño no telegrafía: no hay zona de peligro que anunciar, y
    // `try_start` ya mandó el dash a `Dodging` sin pasar por `Windup`.
    if damaging(t) {
        ev.push(Event::Telegraph {
            by: Side::Boss,
            act: t.act(),
            shape: hitbox(t, boss.pos, param),
        });
    }
    true
}

/// Resuelve la fase activa del boss. Se llama una vez, en la transición a
/// `Active`.
pub fn resolve_boss(w: &mut World, t: ToolId, param: f32, ev: &mut StepEvents) {
    // El dash nunca llega acá: `try_start` lo manda a `Dodging`, que no emite
    // `ToActive`. La guarda está para que siga siendo cierto si alguien le
    // saca los i-frames.
    if !damaging(t) {
        return;
    }
    if t == ToolId::Cannon {
        let dir = Vec2::from_angle(param);
        w.projectiles.push(Projectile {
            pos: w.boss.pos.add(dir.scale(w.boss.radius + CANNON_RADIUS)),
            vel: dir.scale(CANNON_SPEED),
            radius: CANNON_RADIUS,
            damage: damage(t),
            ttl: CANNON_TTL,
            owner: Side::Boss,
        });
        return; // el whiff del cañón lo decide el proyectil al morir
    }
    let shape = hitbox(t, w.boss.pos, param);
    apply(w, Side::Boss, t.act(), shape, damage(t), ev);
}

/// Alcance, semiapertura y daño del golpe del jugador. `None` para esquiva y
/// parry: su efecto es no recibir, no golpear.
fn player_golpe(a: PlayerAction) -> Option<(f32, f32, i32)> {
    match a {
        PlayerAction::Attack => Some((PLAYER_REACH, PLAYER_ARC, 9)),
        // Esquiva y parry no golpean; la habilidad tampoco **de cerca**: es un
        // proyectil y lo resuelve `step_projectiles`.
        PlayerAction::Dodge | PlayerAction::Parry | PlayerAction::Ability => None,
    }
}

/// El arco que va a barrer el jugador. Vive en el motor y no en el render por
/// la misma razón que el del boss: lo que se dibuja tiene que ser exactamente
/// lo que golpea.
pub fn player_hitbox(a: PlayerAction, origin: Vec2, facing: f32) -> Option<Shape> {
    // El cañón no golpea al dispararse: se marca por dónde va a pasar el
    // proyectil, que es lo que el boss necesita para apartarse. Misma forma que
    // la telegrafía del cañón del boss, y por la misma razón.
    if a == PlayerAction::Ability {
        let dir = Vec2::from_angle(facing);
        return Some(Shape::Rect {
            c: origin.add(dir.scale(PLAYER_CANNON_TELL * 0.5)),
            half: Vec2::new(PLAYER_CANNON_TELL * 0.5, PLAYER_CANNON_RADIUS),
            facing,
        });
    }
    let (r, half_angle, _) = player_golpe(a)?;
    Some(Shape::Arc {
        c: origin,
        r,
        facing,
        half_angle,
    })
}

/// Puerta única para las acciones del jugador, simétrica a [`begin`]. Emite el
/// evento de forma al entrar en windup para que el render pueda animar el
/// golpe sin conocer su geometría.
pub fn begin_player(player: &mut Actor, a: PlayerAction, param: f32, ev: &mut StepEvents) -> bool {
    if !actor::try_start(player, a.act(), param, actor::player_frames(a)) {
        return false;
    }
    if let Some(shape) = player_hitbox(a, player.pos, param) {
        ev.push(Event::Telegraph {
            by: Side::Player,
            act: a.act(),
            shape,
        });
    }
    true
}

/// Resuelve el ataque del jugador. Vive acá y no en `actor.rs` porque lo que se
/// comparte es la geometría del golpe, no la máquina de estados.
pub fn resolve_player(w: &mut World, a: PlayerAction, param: f32, ev: &mut StepEvents) {
    if a == PlayerAction::Ability {
        let dir = Vec2::from_angle(param);
        w.projectiles.push(Projectile {
            pos: w
                .player
                .pos
                .add(dir.scale(w.player.radius + PLAYER_CANNON_RADIUS)),
            vel: dir.scale(PLAYER_CANNON_SPEED),
            radius: PLAYER_CANNON_RADIUS,
            damage: PLAYER_CANNON_DAMAGE,
            ttl: PLAYER_CANNON_TTL,
            owner: Side::Player,
        });
        return; // como el del boss: el whiff lo decide el proyectil al morir
    }
    let Some((_, _, dmg)) = player_golpe(a) else {
        return;
    };
    let shape = player_hitbox(a, w.player.pos, param).unwrap();
    apply_player(w, a.act(), shape, dmg, ev);
}

/// Aplica una forma contra el actor contrario: acierto, parry o whiff.
fn apply(w: &mut World, by: Side, act: ActId, shape: Shape, dmg: i32, ev: &mut StepEvents) {
    let target = match by {
        Side::Boss => &mut w.player,
        Side::Player => &mut w.boss,
    };
    if !hits(&shape, target.pos, target.radius) {
        ev.push(Event::Whiff { by, act });
        return;
    }

    if actor::invulnerable(target) {
        // Los i-frames comen el golpe. No es un whiff —el boss apuntó bien— y
        // por eso lleva evento propio: mezclarlo con el whiff envenenaría la
        // puntería, y no emitir nada le dejaba al verificador un uso sin
        // resolver que le corría el contexto a todos los aciertos siguientes.
        ev.push(Event::Absorbed { by, act });
        return;
    }

    if parrying(target) {
        ev.push(Event::Parried { by, act });
        return;
    }
    target.hp -= dmg;
    ev.push(Event::Hit {
        by,
        act,
        damage: dmg,
    });
    if !target.alive() {
        ev.push(Event::Death { who: by.other() });
    }
}

fn apply_player(w: &mut World, act: ActId, shape: Shape, dmg: i32, ev: &mut StepEvents) {
    let guardian = crate::minions::guardian_interposes(w, &shape);
    crate::minions::damage_minions_except(w, &shape, dmg, ev, guardian);
    let absorbido = crate::minions::absorb(w, &shape, dmg, ev);
    let restante = dmg - absorbido;
    if restante > 0 {
        apply(w, Side::Player, act, shape, restante, ev);
    }
}

fn parrying(a: &Actor) -> bool {
    matches!(a.state, crate::types::ActorState::Active { act, .. }
        if act == PlayerAction::Parry.act())
}

/// Mueve los proyectiles, los cobra y emite el whiff del cañón cuando uno muere
/// sin tocar a nadie.
pub fn step_projectiles(w: &mut World, ev: &mut StepEvents) {
    let mut i = 0;
    while i < w.projectiles.len() {
        let p = w.projectiles[i];
        let pos = p.pos.add(p.vel.scale(DT));
        let (target_pos, target_r) = match p.owner {
            Side::Boss => (w.player.pos, w.player.radius),
            Side::Player => (w.boss.pos, w.boss.radius),
        };

        let golpea = pos.dist_sq(target_pos) <= (p.radius + target_r) * (p.radius + target_r);
        let golpea_minion = p.owner == Side::Player
            && w.minions.iter().any(|m| {
                m.alive() && pos.dist_sq(m.pos) <= (p.radius + m.radius) * (p.radius + m.radius)
            });
        // Los bordes de la arena paran igual que una pared. Sin esto un disparo
        // al vacío seguía volando fuera del mapa hasta agotar el TTL: 36
        // unidades de proyectil invisible, y el whiff llegaba tarde.
        let fuera = pos.x < 0.0 || pos.y < 0.0 || pos.x > w.arena.size.x || pos.y > w.arena.size.y;
        let choca = fuera
            || w.arena
                .statics
                .iter()
                .copied()
                .chain(w.dynamics.iter().map(|d| d.aabb()))
                .any(|b| pos.dist_sq(closest_on_aabb(pos, &b)) <= p.radius * p.radius);

        // El slot es el de la acción que lo disparó, y **no** es el mismo para
        // los dos lados: `ToolId::Cannon` y `PlayerAction::Dodge` valen los dos
        // 1. Emitirlo siempre como el cañón del boss le habría contado al
        // jugador un acierto de esquiva cada vez que su cañonazo entra.
        let act = match p.owner {
            Side::Boss => ToolId::Cannon.act(),
            Side::Player => PlayerAction::Ability.act(),
        };
        if golpea_minion && golpea {
            w.projectiles.swap_remove(i);
            let shape = Shape::Circle {
                c: pos,
                r: p.radius,
            };
            apply_player(w, PlayerAction::Ability.act(), shape, p.damage, ev);
        } else if golpea_minion {
            w.projectiles.swap_remove(i);
            let shape = Shape::Circle {
                c: pos,
                r: p.radius,
            };
            crate::minions::damage_minions(w, &shape, p.damage, ev);
        } else if golpea {
            w.projectiles.swap_remove(i);
            if p.owner == Side::Player {
                let shape = Shape::Circle {
                    c: pos,
                    r: p.radius,
                };
                crate::minions::damage_minions(w, &shape, p.damage, ev);
                let absorbido = crate::minions::absorb(w, &shape, p.damage, ev);
                if absorbido < p.damage {
                    apply(w, Side::Player, act, shape, p.damage - absorbido, ev);
                }
            } else {
                apply(
                    w,
                    p.owner,
                    act,
                    Shape::Circle {
                        c: pos,
                        r: p.radius,
                    },
                    p.damage,
                    ev,
                );
            }
        } else if choca || p.ttl == 0 {
            w.projectiles.swap_remove(i);
            ev.push(Event::Whiff { by: p.owner, act });
        } else {
            w.projectiles[i].pos = pos;
            w.projectiles[i].ttl -= 1;
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::{advance, Transition};
    use crate::arena;
    use crate::types::{ActorState, Arena, BossAction, MinionKind, PLAYER_HP};

    /// Corre la pelea con el jugador quieto disparando su cañón una vez y el
    /// boss haciendo lo que le digan. Devuelve los eventos de todos los ticks.
    fn dispara_el_jugador(w: &mut World, ticks: u32, boss: BossAction) -> Vec<Event> {
        let mut ev = Vec::new();
        for t in 0..ticks {
            let input = crate::types::PlayerInput {
                move_dir: Vec2::ZERO,
                action: (t == 0).then_some(PlayerAction::Ability),
            };
            ev.extend(crate::step(w, input, boss).events);
        }
        ev
    }

    /// El cañón del jugador existe, vuela y cobra. Y cobra **en su propio
    /// slot**: `ToolId::Cannon` y `PlayerAction::Dodge` valen los dos 1, así que
    /// un proyectil que se anunciara con el slot del boss le estaría contando al
    /// jugador un acierto de esquiva por cada cañonazo que entra.
    #[test]
    fn el_canon_del_jugador_vuela_y_pega_en_su_slot() {
        let mut w = mundo(Vec2::new(10.0, 30.0), Vec2::new(24.0, 30.0));
        w.player.facing = 0.0; // mirando al boss
        let hp = w.boss.hp;

        let ev = dispara_el_jugador(&mut w, 200, BossAction::Idle);

        let golpe = ev.iter().find_map(|e| match e {
            Event::Hit {
                by: Side::Player,
                act,
                damage,
            } => Some((*act, *damage)),
            _ => None,
        });
        assert_eq!(
            golpe,
            Some((PlayerAction::Ability.act(), PLAYER_CANNON_DAMAGE)),
            "el cañón del jugador no llegó, o llegó con el slot equivocado"
        );
        assert_eq!(w.boss.hp, hp - PLAYER_CANNON_DAMAGE);
        assert!(w.projectiles.is_empty(), "el proyectil no se consumió");
        // Y es a distancia de verdad: el espadazo al que reemplaza no llegaba
        // ni de lejos a catorce unidades.
        assert!(PLAYER_REACH * 1.6 < 14.0);
    }

    /// La razón de ser del arma: el boss se puede apartar caminando. Si esto
    /// falla, el cañón es un impuesto y no una decisión, y no hay nada que
    /// aprender ni con el dash ni con la locomoción.
    #[test]
    fn el_boss_puede_esquivar_el_canon_caminando() {
        let mut w = mundo(Vec2::new(10.0, 30.0), Vec2::new(24.0, 30.0));
        w.player.facing = 0.0;
        let hp = w.boss.hp;

        // Andando de costado, perpendicular a la línea de tiro.
        let ev = dispara_el_jugador(&mut w, 200, BossAction::Move(Vec2::new(0.0, 1.0)));

        assert_eq!(
            w.boss.hp, hp,
            "el boss se comió un cañonazo que podía esquivar"
        );
        assert!(
            ev.iter().any(|e| matches!(
                e,
                Event::Whiff {
                    by: Side::Player,
                    ..
                }
            )),
            "el proyectil no murió: ni pegó ni falló"
        );
    }

    /// Arena vacía y grande: los tests de arsenal miden el arma, no la geometría.
    fn mundo(player: Vec2, boss: Vec2) -> World {
        let mut w = World::new(
            Arena {
                id: 0,
                seed: 0,
                size: Vec2::new(60.0, 60.0),
                statics: Vec::new(),
                spawn_player: player,
                spawn_boss: boss,
                dynamics: Vec::new(),
            },
            1,
        );
        w.player.hp = PLAYER_HP;
        w
    }

    /// Corre la herramienta hasta que se resuelve y devuelve los eventos.
    fn disparar(w: &mut World, t: ToolId, param: f32) -> (u16, StepEvents) {
        let mut ev = StepEvents::default();
        assert!(begin(&mut w.boss, t, param, &mut ev));
        for tick in 1..=frames(t).total() {
            if let Transition::ToActive { act, param } = advance(&mut w.boss, boss_table) {
                resolve_boss(w, ToolId::from_u8(act.0).unwrap(), param, &mut ev);
                return (tick, ev);
            }
            crate::actor::integrate(&mut w.boss);
            crate::actor::apply_move(&mut w.boss, Vec2::ZERO, 0.0, crate::actor::BOSS_MAX_SPEED);
        }
        panic!("{t:?} nunca llegó a la fase activa");
    }

    fn dmg(ev: &StepEvents) -> i32 {
        ev.events
            .iter()
            .filter_map(|e| match e {
                Event::Hit { damage, .. } => Some(*damage),
                _ => None,
            })
            .sum()
    }

    fn hubo_whiff(ev: &StepEvents) -> bool {
        ev.events.iter().any(|e| matches!(e, Event::Whiff { .. }))
    }

    /// El boss no puede vaciar el arsenal de un tirón: gastar una herramienta
    /// enfría a las otras tres. Ver [`RESPIRO`].
    #[test]
    fn un_ataque_enfria_todo_el_arsenal() {
        let mut w = mundo(Vec2::new(32.0, 30.0), Vec2::new(30.0, 30.0));
        let mut ev = StepEvents::default();
        assert!(begin(&mut w.boss, ToolId::Hammer, 0.0, &mut ev));
        for t in [ToolId::Cannon, ToolId::Wave, ToolId::Charge] {
            assert!(
                w.boss.cooldowns[t as usize] >= RESPIRO,
                "{t:?} quedó disponible justo después del martillazo"
            );
        }
        // Y no acorta el cooldown propio de la herramienta, que es más largo.
        assert_eq!(
            w.boss.cooldowns[ToolId::Hammer as usize],
            frames(ToolId::Hammer).cooldown
        );
    }

    #[test]
    fn todas_telegrafian_al_entrar_en_windup() {
        for t in [ToolId::Hammer, ToolId::Cannon, ToolId::Wave, ToolId::Charge] {
            let mut w = mundo(Vec2::new(30.0, 30.0), Vec2::new(28.0, 30.0));
            let mut ev = StepEvents::default();
            assert!(begin(&mut w.boss, t, 0.0, &mut ev));
            assert!(
                matches!(ev.events[0], Event::Telegraph { .. }),
                "{t:?} no telegrafió"
            );
            assert!(matches!(w.boss.state, ActorState::Windup { .. }));
        }
    }

    #[test]
    fn el_martillo_pega_en_el_tick_del_windup() {
        // Jugador a 2 unidades, dentro del alcance de 3.2.
        let mut w = mundo(Vec2::new(32.0, 30.0), Vec2::new(30.0, 30.0));
        let (tick, ev) = disparar(&mut w, ToolId::Hammer, 0.0);
        assert_eq!(tick, frames(ToolId::Hammer).windup);
        assert_eq!(dmg(&ev), damage(ToolId::Hammer));
        assert_eq!(w.player.hp, PLAYER_HP - damage(ToolId::Hammer));
    }

    #[test]
    fn el_martillo_fuera_de_alcance_es_whiff() {
        let mut w = mundo(Vec2::new(38.0, 30.0), Vec2::new(30.0, 30.0));
        let (_, ev) = disparar(&mut w, ToolId::Hammer, 0.0);
        assert!(hubo_whiff(&ev));
        assert_eq!(w.player.hp, PLAYER_HP);
    }

    /// Apuntar mal es el fallo característico del boss del día 1.
    #[test]
    fn el_martillo_apuntado_al_reves_es_whiff() {
        let mut w = mundo(Vec2::new(32.0, 30.0), Vec2::new(30.0, 30.0));
        let (_, ev) = disparar(&mut w, ToolId::Hammer, core::f32::consts::PI);
        assert!(hubo_whiff(&ev));
        assert_eq!(w.player.hp, PLAYER_HP);
    }

    #[test]
    fn la_onda_alcanza_hasta_su_radio_y_no_mas() {
        // Radio 5: pega a 4 unidades, falla a 7.
        let mut cerca = mundo(Vec2::new(34.0, 30.0), Vec2::new(30.0, 30.0));
        let (_, ev) = disparar(&mut cerca, ToolId::Wave, 5.0);
        assert_eq!(dmg(&ev), damage(ToolId::Wave));

        let mut lejos = mundo(Vec2::new(37.0, 30.0), Vec2::new(30.0, 30.0));
        let (_, ev) = disparar(&mut lejos, ToolId::Wave, 5.0);
        assert!(hubo_whiff(&ev));
    }

    #[test]
    fn el_radio_de_la_onda_esta_topeado() {
        // El parámetro sale del modelo: fuera de rango no puede volverse global.
        let mut w = mundo(
            Vec2::new(30.0 + WAVE_MAX_R + 2.0, 30.0),
            Vec2::new(30.0, 30.0),
        );
        let (_, ev) = disparar(&mut w, ToolId::Wave, 1000.0);
        assert!(hubo_whiff(&ev));
    }

    #[test]
    fn el_canon_dispara_un_proyectil_y_pega_al_llegar() {
        let mut w = mundo(Vec2::new(38.0, 30.0), Vec2::new(30.0, 30.0));
        let (_, mut ev) = disparar(&mut w, ToolId::Cannon, 0.0);
        assert_eq!(w.projectiles.len(), 1, "el disparo no golpea, lanza");
        assert_eq!(dmg(&ev), 0);

        for _ in 0..CANNON_TTL {
            step_projectiles(&mut w, &mut ev);
            if w.projectiles.is_empty() {
                break;
            }
        }
        assert_eq!(dmg(&ev), damage(ToolId::Cannon));
        assert_eq!(w.player.hp, PLAYER_HP - damage(ToolId::Cannon));
        assert!(!hubo_whiff(&ev));
    }

    #[test]
    fn el_proyectil_que_se_agota_es_whiff() {
        let mut w = mundo(Vec2::new(30.0, 55.0), Vec2::new(30.0, 30.0));
        let (_, mut ev) = disparar(&mut w, ToolId::Cannon, 0.0); // dispara a +x, el jugador está a +y
        for _ in 0..=CANNON_TTL {
            step_projectiles(&mut w, &mut ev);
        }
        assert!(w.projectiles.is_empty());
        assert!(hubo_whiff(&ev));
        assert_eq!(w.player.hp, PLAYER_HP);
    }

    /// Un disparo al vacío muere en el borde, no 36 unidades más allá.
    #[test]
    fn el_proyectil_muere_en_el_borde_de_la_arena() {
        let mut w = mundo(Vec2::new(5.0, 5.0), Vec2::new(50.0, 30.0));
        let (_, mut ev) = disparar(&mut w, ToolId::Cannon, 0.0); // dispara a +x
        let mut ticks = 0;
        while !w.projectiles.is_empty() && ticks < CANNON_TTL {
            step_projectiles(&mut w, &mut ev);
            ticks += 1;
        }
        assert!(w.projectiles.is_empty());
        // El borde está a 10 unidades y el proyectil avanza 0.3 por tick.
        assert!(ticks < 40, "sobrevivió {ticks} ticks fuera del mapa");
        assert!(hubo_whiff(&ev));
    }

    #[test]
    fn el_proyectil_lo_para_una_pared() {
        let mut w = mundo(Vec2::new(38.0, 30.0), Vec2::new(30.0, 30.0));
        w.arena.statics.push(crate::types::Aabb {
            min: Vec2::new(34.0, 20.0),
            max: Vec2::new(35.0, 40.0),
        });
        let (_, mut ev) = disparar(&mut w, ToolId::Cannon, 0.0);
        for _ in 0..CANNON_TTL {
            step_projectiles(&mut w, &mut ev);
            if w.projectiles.is_empty() {
                break;
            }
        }
        assert!(hubo_whiff(&ev), "la cobertura tiene que servir de algo");
        assert_eq!(w.player.hp, PLAYER_HP);
    }

    #[test]
    fn la_embestida_pega_en_el_recorrido_no_solo_al_final() {
        // Jugador a 2 unidades: el boss todavía no llegó, pero el barrido sí.
        let mut w = mundo(Vec2::new(32.0, 30.0), Vec2::new(30.0, 30.0));
        let (_, ev) = disparar(&mut w, ToolId::Charge, 0.0);
        assert_eq!(dmg(&ev), damage(ToolId::Charge));
    }

    #[test]
    fn la_embestida_falla_a_un_costado() {
        let mut w = mundo(Vec2::new(32.0, 33.0), Vec2::new(30.0, 30.0));
        let (_, ev) = disparar(&mut w, ToolId::Charge, 0.0);
        assert!(hubo_whiff(&ev));
    }

    /// El decal marca `CHARGE_REACH`; la simulación tiene que recorrer eso.
    /// Si alguien toca `DAMP` o `CHARGE_DASH`, este test lo cuenta.
    #[test]
    fn la_embestida_recorre_lo_que_telegrafia() {
        let mut w = mundo(Vec2::new(50.0, 30.0), Vec2::new(30.0, 30.0));
        let inicio = w.boss.pos;
        let mut ev = StepEvents::default();
        begin(&mut w.boss, ToolId::Charge, 0.0, &mut ev);
        for _ in 0..frames(ToolId::Charge).total() {
            advance(&mut w.boss, boss_table);
            crate::actor::apply_move(&mut w.boss, Vec2::ZERO, 0.0, 1e9);
            crate::actor::integrate(&mut w.boss);
        }
        let recorrido = w.boss.pos.dist(inicio);
        assert!(
            (recorrido - CHARGE_REACH).abs() < CHARGE_REACH * 0.1,
            "recorrió {recorrido}, el decal dice {CHARGE_REACH}"
        );
    }

    #[test]
    fn los_iframes_comen_el_golpe_sin_contarlo_como_whiff() {
        let mut w = mundo(Vec2::new(32.0, 30.0), Vec2::new(30.0, 30.0));
        crate::actor::try_start(
            &mut w.player,
            PlayerAction::Dodge.act(),
            core::f32::consts::PI,
            crate::actor::player_frames(PlayerAction::Dodge),
        );
        assert!(actor::invulnerable(&w.player));
        let pos = w.player.pos;
        w.player.vel = Vec2::ZERO; // aislar el efecto de los i-frames del dash
        w.player.pos = pos;

        let mut ev = StepEvents::default();
        resolve_boss(&mut w, ToolId::Hammer, 0.0, &mut ev);
        assert_eq!(w.player.hp, PLAYER_HP);
        assert!(!hubo_whiff(&ev), "el boss apuntó bien: no es whiff");
        assert_eq!(dmg(&ev), 0);
    }

    #[test]
    fn el_parry_convierte_el_golpe_en_evento_de_parry() {
        let mut w = mundo(Vec2::new(32.0, 30.0), Vec2::new(30.0, 30.0));
        let f = crate::actor::player_frames(PlayerAction::Parry);
        crate::actor::try_start(&mut w.player, PlayerAction::Parry.act(), 0.0, f);
        for _ in 0..f.windup {
            advance(&mut w.player, crate::actor::player_table);
        }
        assert!(matches!(w.player.state, ActorState::Active { .. }));

        let mut ev = StepEvents::default();
        resolve_boss(&mut w, ToolId::Hammer, 0.0, &mut ev);
        assert_eq!(w.player.hp, PLAYER_HP);
        assert!(ev.events.iter().any(|e| matches!(e, Event::Parried { .. })));
    }

    #[test]
    fn el_jugador_pega_al_boss_y_puede_matarlo() {
        let mut w = mundo(Vec2::new(30.0, 30.0), Vec2::new(31.5, 30.0));
        w.boss.hp = 9;
        let mut ev = StepEvents::default();
        resolve_player(&mut w, PlayerAction::Attack, 0.0, &mut ev);
        assert_eq!(w.boss.hp, 0);
        assert!(ev
            .events
            .iter()
            .any(|e| matches!(e, Event::Death { who: Side::Boss })));
    }

    #[test]
    fn el_jugador_puede_dañar_un_minion() {
        let mut w = mundo(Vec2::new(30.0, 30.0), Vec2::new(32.0, 30.0));
        let mut ev = StepEvents::default();
        crate::minions::deploy(&mut w, MinionKind::Controller, 0.0, &mut ev);
        w.minions[0].pos = Vec2::new(31.0, 30.0);
        let hp = w.minions[0].hp;
        resolve_player(&mut w, PlayerAction::Attack, 0.0, &mut ev);
        assert!(w.minions[0].hp < hp);
        assert!(ev
            .events
            .iter()
            .any(|e| matches!(e, Event::MinionHit { .. })));
    }

    #[test]
    fn guardian_interpuesto_absorbe_solo_el_daño_que_le_queda() {
        let mut w = mundo(Vec2::new(30.0, 30.0), Vec2::new(32.0, 30.0));
        let mut ev = StepEvents::default();
        crate::minions::deploy(&mut w, MinionKind::Guardian, 0.0, &mut ev);
        w.minions[0].pos = Vec2::new(31.0, 30.0);
        w.minions[0].hp = 4;
        let boss_hp = w.boss.hp;
        resolve_player(&mut w, PlayerAction::Attack, 0.0, &mut ev);
        assert_eq!(w.minions[0].hp, 0);
        assert_eq!(w.boss.hp, boss_hp - 5);
        assert!(ev
            .events
            .iter()
            .any(|e| matches!(e, Event::GuardianAbsorbed { amount: 4 })));
    }

    #[test]
    fn el_jugador_fuera_de_alcance_hace_whiff() {
        let mut w = mundo(Vec2::new(30.0, 30.0), Vec2::new(36.0, 30.0));
        let mut ev = StepEvents::default();
        resolve_player(&mut w, PlayerAction::Attack, 0.0, &mut ev);
        assert!(hubo_whiff(&ev));
    }

    /// Las cuatro siluetas tienen que ser distinguibles: si dos herramientas
    /// proyectan la misma sombra, la telegrafía llega tarde.
    #[test]
    fn cada_herramienta_tiene_una_forma_distinta() {
        let o = Vec2::new(10.0, 10.0);
        let formas: Vec<_> = [ToolId::Hammer, ToolId::Cannon, ToolId::Wave, ToolId::Charge]
            .iter()
            .map(|t| hitbox(*t, o, 0.0))
            .collect();
        for (i, a) in formas.iter().enumerate() {
            for b in &formas[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    /// En la arena real, el bloque central bloquea al cañón desde el spawn.
    #[test]
    fn la_cobertura_de_launch_para_el_canon() {
        let mut w = World::new(arena::launch(), 1);
        let mut ev = StepEvents::default();
        let dir = w.player.pos.sub(w.boss.pos).angle();
        begin(&mut w.boss, ToolId::Cannon, dir, &mut ev);
        for _ in 0..frames(ToolId::Cannon).windup {
            advance(&mut w.boss, boss_table);
        }
        resolve_boss(&mut w, ToolId::Cannon, dir, &mut ev);
        for _ in 0..CANNON_TTL {
            step_projectiles(&mut w, &mut ev);
            if w.projectiles.is_empty() {
                break;
            }
        }
        assert_eq!(
            w.player.hp, PLAYER_HP,
            "el bloque central tenía que pararlo"
        );
        assert!(hubo_whiff(&ev));
    }
}
