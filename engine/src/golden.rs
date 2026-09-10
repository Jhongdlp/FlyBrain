//! T7 — La pelea guionada que sirve de patrón de determinismo.
//!
//! Vive en `src/` y no en `tests/` para que la pueda llamar también el binario
//! wasm: el criterio de T7 es que **nativo y wasm den el mismo hash**, y eso
//! solo se comprueba corriendo el mismo código en los dos.
//!
//! El guion no es una lista fija de acciones: es una heurística que mira el
//! mundo, y de ahí sale el log. Así la pelea tiene golpes reales, whiffs,
//! coberturas y cajas empujadas en vez de 3600 ticks de dar vueltas.
//!
//! Todas las decisiones salen de valores **cuantizados** (`player_dir`,
//! `boss_dir`, `dequant`). Si el guion usara ángulos continuos, el log no
//! sobreviviría al ida y vuelta y el verificador de T8 se caería solo.

use crate::arena;
use crate::log::{self, dir_index, FightLog, Record, N_BOSS_DIRS, N_PLAYER_DIRS};
use crate::raycast::line_of_sight;
use crate::types::*;
use crate::step;

pub const GOLDEN_SEED: u64 = 0x5EED_0000_1234_ABCD;
/// Tope de la pelea guionada. La duración real sale más corta: el jugador
/// del guion se muere antes.
pub const GOLDEN_TICKS: u32 = 3600;

fn quantize_player(v: Vec2) -> Vec2 {
    log::player_dir(dir_index(v, N_PLAYER_DIRS))
}

fn quantize_boss(v: Vec2) -> Vec2 {
    log::boss_dir(dir_index(v, N_BOSS_DIRS))
}

/// Ángulo cuantizado al espacio de parámetros de la herramienta.
fn aim(t: ToolId, v: Vec2) -> f32 {
    log::dequant(t, log::quant(t, v.angle()))
}

/// Rodea la cobertura en vez de empujarla. Sin esto el guion es un actor
/// apretado contra el bloque central durante mil ticks: la arena está diseñada
/// justamente para que la línea recta no alcance.
///
/// No es pathfinding: si no hay visión, se va de costado, y elige el costado
/// que sí la tiene. Alcanza para una arena convexa y no hace falta más.
fn navegar(w: &World, desde: Vec2, hasta: Vec2) -> Vec2 {
    let d = hasta.sub(desde);
    if line_of_sight(desde, hasta, w).0 {
        return d;
    }
    let p = d.perp().normalized();
    if line_of_sight(desde.add(p.scale(2.5)), hasta, w).0 {
        p
    } else {
        p.scale(-1.0)
    }
}

/// Qué hace el jugador este tick. Ataca de cerca, esquiva lo telegrafiado y se
/// desvía a empujar una caja cada tanto para que el guion toque cuerpos
/// dinámicos.
fn player_ai(w: &World) -> PlayerInput {
    // Las dos escapadas a las cajas tienen que caer **dentro** de la pelea: con
    // los cooldowns nuevos dura menos, y a los 2400 ticks ya no queda nadie.
    // La caja **más cercana**, no una posición fija del mapa: la escapada tiene
    // que ser local. Con un destino fijo al otro lado del muro central el
    // jugador se pasaba los 400 ticks del viaje apoyado contra la pared —
    // `navegar` es un esquive de costado, no pathfinding, y no rodea un muro
    // que llega al borde de la arena.
    // Las dos escapadas a las cajas van **a donde están las cajas**, leídas de
    // la arena. Estaban escritas a mano y apuntaban a posiciones de una arena
    // anterior: el guion cruzaba el mapa hacia un muro y no tocaba un solo
    // cuerpo dinámico, o sea que el golden dejó de cubrir los empujables sin
    // que nada lo dijera hasta que el test de cobertura lo cazó.
    let caja_n = |i: usize| w.arena.dynamics.get(i).map(|d| d.pos);
    let (objetivo, caja) = match w.tick / 400 {
        // Las dos cajas en **una sola** excursión, al principio: están a menos
        // de cinco unidades una de otra, y así el resto de la pelea queda
        // entero. Con una ventana por caja el jugador gastaba 800 ticks
        // paseando y ya no volvía a engancharse — la pelea llegaba al tope de
        // tiempo sin un solo golpe.
        0 => {
            let i = (w.tick >= 200) as usize;
            (caja_n(i).unwrap_or(w.boss.pos), caja_n(i).is_some())
        }
        // Con poca vida se despega en vez de morir: sin esto la pelea se acaba
        // a los 800 ticks y el golden test deja de ejercitar el tramo largo.
        // Pero se despega **a ratos**: con los cooldowns largos, huir siempre
        // es huir para siempre, y el guion se quedaba en tablas sin muerto.
        _ if w.player.hp < 45 && w.tick % 600 < 450 => (w.arena.spawn_player, false),
        _ => (w.boss.pos, false),
    };
    let dist = objetivo.dist(w.player.pos);
    // A la caja se va **derecho** y sin frenar: `navegar` la esquivaría —es un
    // obstáculo, le corta la línea de visión— y el guion nunca tocaría un
    // cuerpo dinámico.
    //
    // Por eso las dos excursiones van al principio, mientras el jugador sigue
    // en su mitad: las dos cajas están al oeste de la espina central, y yendo
    // derecho desde el lado de allá se pasaba la excursión entera empujando el
    // muro. Medido cuando pasó: una de las dos cajas no se movía ni un
    // milímetro, y el test de cobertura fue lo único que lo dijo.
    let hacia = if caja {
        objetivo.sub(w.player.pos)
    } else {
        navegar(w, w.player.pos, objetivo)
    };
    let frenar_a = if caja { 0.0 } else { 1.6 };

    // Esquiva sobre el final del windup, no al principio: los i-frames duran 12
    // ticks y el windup del boss dura entre 20 y 34, así que salir temprano es
    // salir para nada. Que esto funcione es la prueba de que la telegrafía se
    // puede leer.
    //
    // Y esquiva en **ciclos alternos**, no dentro de cada uno (`tick % 400 < 40`, ver
    // `boss_ai`). El guion existe para cubrir el motor, y un jugador que evade
    // todo deja al martillo sin un solo acierto que ejercitar: es exactamente
    // lo que pasó cuando `apply_move` dejó de clampear los impulsos y la
    // esquiva empezó a mover de verdad. Que sea una ventana y no un azar
    // mantiene el fixture legible: se sabe qué tramo cubre qué.
    let por_impactar = matches!(w.boss.state, ActorState::Windup { ticks_left, .. } if ticks_left <= 10);
    if por_impactar && (w.tick / 400) % 2 == 1 && w.boss.pos.dist(w.player.pos) < 6.0 {
        return PlayerInput {
            move_dir: quantize_player(hacia.scale(-1.0)),
            action: Some(PlayerAction::Dodge),
        };
    }

    let action = if !caja && objetivo == w.boss.pos && dist < 2.2 {
        match w.tick % 210 {
            0 => Some(PlayerAction::Ability),
            30 => Some(PlayerAction::Parry),
            _ => Some(PlayerAction::Attack),
        }
    } else {
        None
    };

    let move_dir = if dist > frenar_a { quantize_player(hacia) } else { Vec2::ZERO };
    PlayerInput { move_dir, action }
}

/// Qué hace el boss. Rota las cuatro herramientas por reloj: el objetivo es
/// ejercitar el arsenal entero, no jugar bien.
/// Cada herramienta tiene su cuarto del ciclo y tira **la primera vez que
/// alcanza**, no en un tick fijo: con el reloj a secas el turno del martillo
/// caía con el jugador a diez unidades y el guion dejaba de ejercitar sus
/// aciertos. Los intentos siguientes del mismo cuarto los descarta `begin` por
/// cooldown, así que sale uno por turno.
///
/// El ciclo tiene que ser más largo que el cooldown más largo (la onda, 330) y
/// cada cuarto más ancho que [`weapons::RESPIRO`], o una de las cuatro
/// herramientas no llega a salir nunca.
const MARGEN_GUION: f32 = 2.0;
fn boss_ai(w: &World) -> BossAction {
    let hacia = w.player.pos.sub(w.boss.pos);
    let rumbo = navegar(w, w.boss.pos, w.player.pos);
    let d = hacia.len() - w.player.radius;
    // Con margen a propósito: el guion tiene que producir aciertos **y**
    // whiffs de las cuatro, y tirando solo dentro del alcance exacto el
    // martillo no fallaba nunca.
    let alcanza = |t: ToolId| d <= crate::weapons::reach(t) * MARGEN_GUION;
    match w.tick % 400 {
        // El martillo va partido en dos porque es el único que, tirando
        // siempre a la primera que alcanza, no falla nunca: el windup dura lo
        // bastante para que el jugador termine de acercarse. La primera mitad
        // del cuarto tira **fuera de alcance** a propósito —sin mirar el
        // margen— para cubrir la señal de whiff; la segunda tira normal y
        // cubre el acierto.
        0..50 if d > crate::weapons::reach(ToolId::Hammer) => {
            BossAction::Use(ToolId::Hammer, aim(ToolId::Hammer, hacia))
        }
        50..100 if alcanza(ToolId::Hammer) => {
            BossAction::Use(ToolId::Hammer, aim(ToolId::Hammer, hacia))
        }
        100..200 if alcanza(ToolId::Cannon) => {
            BossAction::Use(ToolId::Cannon, aim(ToolId::Cannon, hacia))
        }
        200..300 if alcanza(ToolId::Wave) => {
            // Radio a la distancia real y no fijo: con un radio de tabla la
            // onda no acertaba nunca desde que el guion tira solo con alcance.
            BossAction::Use(
                ToolId::Wave,
                log::dequant(ToolId::Wave, log::quant(ToolId::Wave, hacia.len())),
            )
        }
        300..400 if alcanza(ToolId::Charge) => {
            BossAction::Use(ToolId::Charge, aim(ToolId::Charge, hacia))
        }
        t if t % 17 == 0 => BossAction::Idle,
        _ => BossAction::Move(quantize_boss(rumbo)),
    }
}

/// Corre la pelea guionada y devuelve su log. Guarda solo los cambios de
/// entrada, igual que el cliente real.
pub fn script() -> FightLog {
    let mut w = World::new(arena::launch(), GOLDEN_SEED);
    let mut records: Vec<Record> = Vec::new();
    let mut ultimo: Option<(PlayerInput, BossAction)> = None;

    for _ in 0..GOLDEN_TICKS {
        if w.over() {
            break;
        }
        let tick = w.tick;
        let input = player_ai(&w);
        let action = boss_ai(&w);
        if ultimo != Some((input, action)) {
            records.push(Record { tick, input, action });
            ultimo = Some((input, action));
        }
        step(&mut w, input, action);
    }

    FightLog {
        version: log::FORMAT_VERSION,
        world_seed: GOLDEN_SEED,
        arena_id: w.arena.id,
        arena_seed: w.arena.seed,
        brain_version: 0,
        player_id: 0,
        // La duración real, no el tope: declarar más de lo que duró es relleno
        // y el verificador de T8 lo rechaza, con razón.
        ticks: w.tick,
        records,
    }
}

/// Re-simula un log desde cero. Que esto reproduzca el mundo bit a bit es lo
/// que permite grabar una pelea en la GPU y reproducirla en el navegador.
pub fn simulate(log: &FightLog) -> World {
    let arena = arena::by_id(log.arena_id).expect("arena desconocida");
    let mut w = World::new(arena, log.world_seed);
    for (input, action) in log::expand(log) {
        if w.over() {
            break;
        }
        step(&mut w, input, action);
    }
    w
}

/// El número que tiene que coincidir entre nativo y wasm.
pub fn golden_hash() -> u64 {
    crate::hash_world(&simulate(&script()))
}

/// Export para el chequeo de determinismo en wasm (`scripts/wasm-determinism.sh`).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn golden_hash_c() -> u64 {
    golden_hash()
}

/// Estado por tick, para que un fallo señale el frame exacto donde diverge.
pub fn trace(log: &FightLog) -> Vec<u64> {
    let arena = arena::by_id(log.arena_id).expect("arena desconocida");
    let mut w = World::new(arena, log.world_seed);
    let mut out = Vec::with_capacity(log.ticks as usize);
    for (input, action) in log::expand(log) {
        if w.over() {
            break;
        }
        step(&mut w, input, action);
        out.push(crate::hash_world(&w));
    }
    out
}

/// Resumen legible de la pelea, para que el golden test compruebe que el guion
/// sigue ejercitando lo que dice ejercitar y no se volvió 3600 ticks de nada.
#[derive(Debug, PartialEq, Eq)]
pub struct Resumen {
    pub ticks: u32,
    pub player_hp: i32,
    pub boss_hp: i32,
    pub golpes: [u32; N_TOOLS],
    pub whiffs: [u32; N_TOOLS],
    pub telegrafias: u32,
    pub cajas_movidas: u32,
}

pub fn resumen() -> Resumen {
    let log = script();
    let arena = arena::by_id(log.arena_id).unwrap();
    let cajas0: Vec<Vec2> = arena.dynamics.iter().map(|d| d.pos).collect();
    let mut w = World::new(arena, log.world_seed);
    let (mut golpes, mut whiffs, mut telegrafias) = ([0; N_TOOLS], [0; N_TOOLS], 0);

    for (input, action) in log::expand(&log) {
        if w.over() {
            break;
        }
        for e in step(&mut w, input, action).events {
            match e {
                Event::Hit { by: Side::Boss, act, .. } => golpes[act.0 as usize] += 1,
                // "No conectó", igual que en `FightOutcome::whiffs`: cuenta
                // también el parreado y el esquivado. La embestida lleva dash,
                // o sea que embiste **hacia** el jugador y cierra la distancia
                // ella sola: geométricamente no falla casi nunca, y su modo de
                // fallo real es que la esquiven. Contando solo `Whiff`, este
                // resumen decía que la embestida nunca fallaba y el test de
                // cobertura pedía algo imposible.
                Event::Whiff { by: Side::Boss, act }
                | Event::Parried { by: Side::Boss, act }
                | Event::Absorbed { by: Side::Boss, act } => whiffs[act.0 as usize] += 1,
                Event::Telegraph { by: Side::Boss, .. } => telegrafias += 1,
                _ => {}
            }
        }
    }

    Resumen {
        ticks: w.tick,
        player_hp: w.player.hp,
        boss_hp: w.boss.hp,
        golpes,
        whiffs,
        telegrafias,
        cajas_movidas: w
            .dynamics
            .iter()
            .zip(&cajas0)
            .filter(|(d, p0)| d.pos.dist(**p0) > 0.05)
            .count() as u32,
    }
}
