use crate::actor::DAMP;
use crate::types::{Event, Minion, MinionKind, Shape, StepEvents, Vec2, World, DT, MAX_MINIONS};

pub const GUARDIAN_HP: i32 = 36;
pub const GUARDIAN_RADIUS: f32 = 0.65;
pub const GUARDIAN_SPEED: f32 = 5.0;
pub const GUARDIAN_ABSORB_MAX: i32 = GUARDIAN_HP;
pub const CONTROLLER_HP: i32 = 20;
pub const CONTROLLER_RADIUS: f32 = 0.6;
pub const CONTROLLER_ZONE: f32 = 3.2;
pub const CONTROLLER_SLOW: f32 = 0.45;
pub const DEPLOY_COOLDOWN: u16 = 240;

/// Cuánto dura un súbdito. Seis segundos, no quince.
///
/// Con 900 ticks el minion cubría una pelea entera y dejaba de ser una jugada
/// para volverse decorado permanente: nada que leer, nada que aprender, y una
/// ventana de crédito tan larga que cualquier cosa que pasara adentro le
/// contaba como mérito. Seis segundos es una jugada — el jugador la ve
/// aparecer, la sufre y la ve irse.
pub const TTL: u16 = 360;

/// Hasta dónde el boss puede plantar un súbdito. Es el mismo número con el que
/// el cerebro decide si el brazo entra en la baraja: alcance es geometría, no
/// política.
pub const DEPLOY_RANGE: f32 = 14.0;

/// Cuánto se corre el campo del controlador hacia la ruta de escape del
/// jugador. Medio radio de zona: lo suficiente para tapar la salida y poco para
/// que el jugador siga dentro del campo —si se corriera entero, plantarlo
/// dejaría al jugador libre y sería un regalo en vez de una trampa.
pub const EMPUJON: f32 = CONTROLLER_ZONE * 0.5;

pub fn can_deploy(w: &World, kind: MinionKind) -> bool {
    w.minions.len() < MAX_MINIONS && w.minion_cooldowns[kind as usize] == 0
}

pub fn deploy(w: &mut World, kind: MinionKind, param: f32, ev: &mut StepEvents) -> bool {
    if !can_deploy(w, kind) {
        return false;
    }
    let dir = Vec2::from_angle(param);
    let (radius, hp) = match kind {
        MinionKind::Guardian => (GUARDIAN_RADIUS, GUARDIAN_HP),
        MinionKind::Controller => (CONTROLLER_RADIUS, CONTROLLER_HP),
    };
    // **Dónde cae es la mitad de lo que significa cada súbdito.**
    //
    // El guardián se planta delante del boss porque su trabajo es meterse en
    // la línea del disparo. El controlador se planta **encima del jugador**:
    // es negación de terreno, y un campo de lentitud pegado al boss es lo
    // contrario —premia acampar, castiga al jugador justo por acercarse a
    // pegar, y no hay nada que leer porque el efecto siempre está donde el
    // jugador ya tenía que ir. Puesto sobre el jugador, la jugada se cuenta
    // sola: el boss te corta el suelo y vos tenés que salir de ahí.
    let dist = match kind {
        MinionKind::Guardian => 2.0,
        MinionKind::Controller => w.player.pos.dist(w.boss.pos).min(DEPLOY_RANGE),
    };
    let mut pos = w.boss.pos.add(dir.scale(dist));
    // **El empujón hacia la trampa.** El campo no se planta encima del jugador
    // sino corrido hacia su ruta de escape, así que el suelo que le queda libre
    // es el del lado cerrado. En un bolsillo eso es acorralarlo; a campo
    // abierto [`crate::raycast::salida`] devuelve ~cero y el campo cae encima
    // del jugador como antes — la mecánica se enciende sola donde hay
    // geometría que aprovechar.
    //
    // Es colocación, no decisión: dónde está la salida es una resta sobre 16
    // rayos. Lo que el bandit sigue eligiendo es **cuándo** plantar el campo,
    // que es lo que tiene algo que aprender. Arrear al jugador hasta el
    // bolsillo —moverse durante segundos para que la trampa exista— es cadena
    // de crédito larga y eso no sale de un bandit: es fase 2.
    if kind == MinionKind::Controller {
        pos = pos.add(crate::raycast::salida(w.player.pos, w).scale(EMPUJON));
    }
    pos.x = pos.x.max(radius).min(w.arena.size.x - radius);
    pos.y = pos.y.max(radius).min(w.arena.size.y - radius);
    w.minions.push(Minion {
        pos,
        vel: Vec2::ZERO,
        radius,
        hp,
        kind,
        ttl: TTL,
        cooldown: 0,
    });
    w.minion_cooldowns[kind as usize] = DEPLOY_COOLDOWN;
    // **Plantar un súbdito cuesta el arsenal, igual que atacar.** Sin esto el
    // despliegue era gratis: no gastaba nada que el boss pudiera haber usado
    // para pegar, así que UCB lo elegía siempre que estuviera frío y el boss
    // los sacaba mecánicamente. Un brazo sin coste de oportunidad no es una
    // decisión. Ver [`crate::weapons::RESPIRO`].
    for (i, c) in w.boss.cooldowns.iter_mut().enumerate() {
        if i != crate::types::ToolId::Dash as usize {
            *c = (*c).max(crate::weapons::RESPIRO);
        }
    }
    ev.push(Event::MinionSpawned { kind });
    true
}

pub fn controller_slow(w: &World) -> Option<(usize, f32)> {
    w.minions
        .iter()
        .enumerate()
        .find(|(_, m)| {
            m.alive()
                && m.kind == MinionKind::Controller
                && m.pos.dist(w.player.pos) <= CONTROLLER_ZONE
        })
        .map(|(i, _)| (i, CONTROLLER_SLOW))
}

pub fn step(w: &mut World, ev: &mut StepEvents) {
    for cd in &mut w.minion_cooldowns {
        *cd = cd.saturating_sub(1);
    }
    for m in &mut w.minions {
        if !m.alive() {
            continue;
        }
        m.ttl = m.ttl.saturating_sub(1);
        m.cooldown = m.cooldown.saturating_sub(1);
        if m.kind == MinionKind::Guardian {
            let target = w
                .boss
                .pos
                .add(w.player.pos.sub(w.boss.pos).normalized().scale(2.0));
            let dir = target.sub(m.pos).normalized();
            m.vel = m.vel.scale(DAMP).add(dir.scale(GUARDIAN_SPEED * DT));
            let speed_sq = m.vel.len_sq();
            if speed_sq > GUARDIAN_SPEED * GUARDIAN_SPEED {
                m.vel = m.vel.scale(GUARDIAN_SPEED / libm::sqrtf(speed_sq));
            }
            m.pos = m.pos.add(m.vel.scale(DT));
            m.pos.x = m.pos.x.max(m.radius).min(w.arena.size.x - m.radius);
            m.pos.y = m.pos.y.max(m.radius).min(w.arena.size.y - m.radius);
        } else {
            m.vel = Vec2::ZERO;
        }
    }
    let mut i = 0;
    while i < w.minions.len() {
        if !w.minions[i].alive() {
            let kind = w.minions[i].kind;
            w.minions.swap_remove(i);
            ev.push(Event::MinionDespawned { kind });
        } else {
            i += 1;
        }
    }
}

pub fn emit_effects(w: &World, ev: &mut StepEvents) {
    if let Some((i, _)) = controller_slow(w) {
        ev.push(Event::ControllerSlowed {
            kind: w.minions[i].kind,
        });
    }
}

pub fn hits(m: &Minion, shape: &Shape) -> bool {
    crate::weapons::hits(shape, m.pos, m.radius)
}

pub fn guardian_interposes(w: &World, shape: &Shape) -> Option<usize> {
    let total = w.player.pos.dist(w.boss.pos);
    w.minions
        .iter()
        .enumerate()
        .find(|(_, m)| {
            m.alive()
                && m.kind == MinionKind::Guardian
                && hits(m, shape)
                && m.pos.dist(w.player.pos) + m.pos.dist(w.boss.pos) <= total + m.radius
        })
        .map(|(i, _)| i)
}

pub fn damage_minions(w: &mut World, shape: &Shape, damage: i32, ev: &mut StepEvents) {
    damage_minions_except(w, shape, damage, ev, None);
}

pub fn damage_minions_except(
    w: &mut World,
    shape: &Shape,
    damage: i32,
    ev: &mut StepEvents,
    except: Option<usize>,
) {
    for (i, m) in w.minions.iter_mut().enumerate() {
        if Some(i) != except && m.alive() && hits(m, shape) {
            m.hp -= damage;
            ev.push(Event::MinionHit {
                kind: m.kind,
                damage,
            });
        }
    }
}

pub fn absorb(w: &mut World, shape: &Shape, damage: i32, ev: &mut StepEvents) -> i32 {
    let Some(i) = guardian_interposes(w, shape) else {
        return 0;
    };
    let amount = damage.min(w.minions[i].hp.max(0)).min(GUARDIAN_ABSORB_MAX);
    if amount > 0 {
        w.minions[i].hp -= amount;
        ev.push(Event::GuardianAbsorbed { amount });
    }
    amount
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Aabb, Arena};

    fn world() -> World {
        World::new(
            Arena {
                id: 0,
                seed: 0,
                size: Vec2::new(20.0, 20.0),
                statics: vec![],
                spawn_player: Vec2::new(4.0, 10.0),
                spawn_boss: Vec2::new(16.0, 10.0),
                dynamics: vec![],
            },
            1,
        )
    }

    #[test]
    fn guardian_se_mueve_hacia_el_interpuesto() {
        let mut w = world();
        let mut ev = StepEvents::default();
        deploy(&mut w, MinionKind::Guardian, 0.0, &mut ev);
        let antes = w.minions[0].pos.dist(w.player.pos);
        step(&mut w, &mut ev);
        assert!(w.minions[0].pos.dist(w.player.pos) < antes);
    }

    /// La trampa, medida: en un bolsillo el campo se planta **entre el jugador
    /// y la boca**, no encima suyo.
    #[test]
    fn el_controlador_tapa_la_boca_del_bolsillo() {
        let mut w = World::new(
            Arena {
                id: 0,
                seed: 0,
                size: Vec2::new(20.0, 20.0),
                // Bolsillo en U abierto hacia el sur, entre x=8 y x=12.
                statics: vec![
                    Aabb::from_center(Vec2::new(7.5, 16.0), Vec2::new(0.5, 4.0)),
                    Aabb::from_center(Vec2::new(12.5, 16.0), Vec2::new(0.5, 4.0)),
                ],
                spawn_player: Vec2::new(10.0, 18.0),
                spawn_boss: Vec2::new(10.0, 6.0),
                dynamics: vec![],
            },
            1,
        );
        let mut ev = StepEvents::default();
        let hacia = w.player.pos.sub(w.boss.pos);
        deploy(&mut w, MinionKind::Controller, hacia.angle(), &mut ev);
        let m = w.minions[0].pos;
        // Corrido hacia la boca (sur), pero con el jugador todavía dentro.
        assert!(m.y < w.player.pos.y - 0.5, "{m:?}");
        assert!(m.dist(w.player.pos) < CONTROLLER_ZONE, "{m:?}");
        assert_eq!(controller_slow(&w), Some((0, CONTROLLER_SLOW)));
    }

    /// A campo abierto no hay nada que cortar y el campo cae encima del
    /// jugador, como antes de existir el empujón.
    #[test]
    fn a_campo_abierto_el_empujon_desaparece() {
        let mut w = world();
        w.player.pos = Vec2::new(10.0, 10.0);
        w.boss.pos = Vec2::new(14.0, 10.0);
        let mut ev = StepEvents::default();
        let hacia = w.player.pos.sub(w.boss.pos);
        deploy(&mut w, MinionKind::Controller, hacia.angle(), &mut ev);
        assert!(w.minions[0].pos.dist(w.player.pos) < 0.6, "{:?}", w.minions[0].pos);
    }

    #[test]
    fn controller_aplica_zona_determinista() {
        let mut w = world();
        w.player.pos = Vec2::new(10.0, 10.0);
        w.boss.pos = Vec2::new(16.0, 10.0);
        let mut ev = StepEvents::default();
        deploy(
            &mut w,
            MinionKind::Controller,
            core::f32::consts::PI,
            &mut ev,
        );
        w.minions[0].pos = w.player.pos;
        assert_eq!(controller_slow(&w), Some((0, CONTROLLER_SLOW)));
        emit_effects(&w, &mut ev);
        assert!(ev
            .events
            .iter()
            .any(|e| matches!(e, Event::ControllerSlowed { .. })));
    }

    #[test]
    fn guardian_absorbe_hasta_su_tope() {
        let mut w = world();
        w.player.pos = Vec2::new(4.0, 10.0);
        w.boss.pos = Vec2::new(16.0, 10.0);
        let mut ev = StepEvents::default();
        deploy(&mut w, MinionKind::Guardian, 0.0, &mut ev);
        w.minions[0].pos = Vec2::new(10.0, 10.0);
        let shape = Shape::Rect {
            c: Vec2::new(10.0, 10.0),
            half: Vec2::new(20.0, 0.5),
            facing: 0.0,
        };
        assert_eq!(absorb(&mut w, &shape, 100, &mut ev), GUARDIAN_HP);
        assert_eq!(w.minions[0].hp, 0);
    }
}
