//! Binding para el navegador. **Sin `wasm-bindgen`.**
//!
//! El navegador **no decide nada**: recibe la acción del boss por `step_tick` y
//! dibuja. Quién la produce —un log grabado contra el conectoma, o el conectoma
//! en vivo por websocket— es problema de quien llama.
//!
//! Lo que pide el diseño es un buffer plano que JS lea como `Float32Array`
//! sobre la memoria del wasm, sin serializar ni copiar por frame. Eso son
//! exports `extern "C"` y `new Float32Array(memory.buffer, ptr, len)` — el glue
//! de `wasm-bindgen` sobraría, y además pesa.
//!
//! La entrada llega **con el mismo empaquetado que el log** (`log::decode_*`),
//! el mismo que consume `VecEnv` desde Python. Así una pelea grabada en la GPU
//! se reproduce acá tick a tick sin traducir nada.
//!
//! Los punteros que devuelven `create` y `state_ptr` son opacos para JS. Son
//! válidos hasta el próximo `step`: `Vec` puede reasignar y mover el buffer.

use crate::log;
use crate::types::*;
use crate::{arena, step};

/// Tope de proyectiles visibles por frame. El buffer es de tamaño fijo para que
/// JS lea con un stride constante.
pub const MAX_PROJ: usize = 32;
pub const MAX_DYN: usize = 16;
pub const MAX_MINION_STATE: usize = crate::types::MAX_MINIONS;
pub const MAX_EVENTS: usize = 16;

/// Campos por actor en el buffer de estado: x, y, vx, vy, facing, hp, fase,
/// ticks de la fase, slot de la acción.
pub const ACTOR_STRIDE: usize = 9;
/// Campos por proyectil: x, y, vx, vy.
pub const PROJ_STRIDE: usize = 4;
/// Campos por caja: x, y, hx, hy.
pub const DYN_STRIDE: usize = 4;
/// Campos por minion: x, y, vx, vy, radio, hp, kind, ttl.
pub const MINION_STRIDE: usize = 8;
/// Campos por evento: tipo, lado, slot, daño, forma, y cinco números de forma.
pub const EVENT_STRIDE: usize = 10;
/// Telemetría del cerebro: a dónde apunta (x, y), con qué brazo, con cuánta
/// maestría, y cuánto cree que te vas a desviar al ver la telegrafía (2).
///
/// `[tick, terminado, n_proj, n_dyn, n_minions, n_ev]` y después los bloques.
pub const HEADER: usize = 6;
pub const STATE_LEN: usize = HEADER
    + 2 * ACTOR_STRIDE
    + MAX_PROJ * PROJ_STRIDE
    + MAX_DYN * DYN_STRIDE
    + MAX_MINION_STATE * MINION_STRIDE
    + MAX_EVENTS * EVENT_STRIDE;

pub struct Game {
    w: World,
    buf: Vec<f32>,
    /// La pelea grabada, ya expandida a una entrada por tick.
    ///
    /// Expandirla acá y no en JS no es capricho: el formato del log lo define
    /// [`crate::log`], y una segunda implementación en TypeScript es
    /// exactamente lo que rompe la reproducibilidad que justifica el motor.
    cinta: Vec<(PlayerInput, BossAction)>,
    cabeza: usize,
}

fn actor_fields(a: &Actor, out: &mut [f32]) {
    let (fase, ticks, slot) = match a.state {
        ActorState::Idle => (0.0, 0.0, 0.0),
        ActorState::Windup {
            act, ticks_left, ..
        } => (1.0, ticks_left as f32, act.0 as f32),
        ActorState::Active {
            act, ticks_left, ..
        } => (2.0, ticks_left as f32, act.0 as f32),
        ActorState::Recovery { ticks_left } => (3.0, ticks_left as f32, 0.0),
        ActorState::Dodging {
            ticks_left,
            iframes_left,
        } => (4.0, ticks_left as f32, iframes_left as f32),
    };
    out.copy_from_slice(&[
        a.pos.x,
        a.pos.y,
        a.vel.x,
        a.vel.y,
        a.facing,
        a.hp as f32,
        fase,
        ticks,
        slot,
    ]);
}

/// Una forma como seis números, para que JS lea un stride fijo y ramifique por
/// el primero:
///
/// - círculo `[0, x, y, r, 0, 0]`
/// - arco    `[1, x, y, r, facing, semiapertura]`
/// - rect    `[2, x, y, hx, facing, hy]`
fn shape_fields(s: &Shape) -> [f32; 6] {
    match *s {
        Shape::Circle { c, r } => [0.0, c.x, c.y, r, 0.0, 0.0],
        Shape::Arc {
            c,
            r,
            facing,
            half_angle,
        } => [1.0, c.x, c.y, r, facing, half_angle],
        Shape::Rect { c, half, facing } => [2.0, c.x, c.y, half.x, facing, half.y],
    }
}

impl Game {
    fn fill(&mut self, ev: &StepEvents) {
        let b = &mut self.buf;
        b[0] = self.w.tick as f32;
        b[1] = self.w.over() as u8 as f32;
        let np = self.w.projectiles.len().min(MAX_PROJ);
        let nd = self.w.dynamics.len().min(MAX_DYN);
        let nm = self.w.minions.len().min(MAX_MINION_STATE);
        let ne = ev.events.len().min(MAX_EVENTS);
        b[2] = np as f32;
        b[3] = nd as f32;
        b[4] = nm as f32;
        b[5] = ne as f32;

        let mut o = HEADER;
        actor_fields(&self.w.player, &mut b[o..o + ACTOR_STRIDE]);
        o += ACTOR_STRIDE;
        actor_fields(&self.w.boss, &mut b[o..o + ACTOR_STRIDE]);
        o += ACTOR_STRIDE;

        for p in self.w.projectiles.iter().take(np) {
            b[o..o + PROJ_STRIDE].copy_from_slice(&[p.pos.x, p.pos.y, p.vel.x, p.vel.y]);
            o += PROJ_STRIDE;
        }
        o = HEADER + 2 * ACTOR_STRIDE + MAX_PROJ * PROJ_STRIDE;

        for d in self.w.dynamics.iter().take(nd) {
            b[o..o + DYN_STRIDE].copy_from_slice(&[d.pos.x, d.pos.y, d.half.x, d.half.y]);
            o += DYN_STRIDE;
        }
        o = HEADER + 2 * ACTOR_STRIDE + MAX_PROJ * PROJ_STRIDE + MAX_DYN * DYN_STRIDE;
        for m in self.w.minions.iter().take(nm) {
            b[o..o + MINION_STRIDE].copy_from_slice(&[
                m.pos.x,
                m.pos.y,
                m.vel.x,
                m.vel.y,
                m.radius,
                m.hp as f32,
                m.kind as u8 as f32,
                m.ttl as f32,
            ]);
            o += MINION_STRIDE;
        }
        o = HEADER
            + 2 * ACTOR_STRIDE
            + MAX_PROJ * PROJ_STRIDE
            + MAX_DYN * DYN_STRIDE
            + MAX_MINION_STATE * MINION_STRIDE;

        for e in ev.events.iter().take(ne) {
            let (kind, side, act, dmg, shape) = match *e {
                Event::Telegraph { by, act, shape } => (0.0, by as u8, act.0, 0, Some(shape)),
                Event::Hit { by, act, damage } => (1.0, by as u8, act.0, damage, None),
                Event::Whiff { by, act } => (2.0, by as u8, act.0, 0, None),
                Event::Parried { by, act } => (3.0, by as u8, act.0, 0, None),
                Event::Absorbed { by, act } => (5.0, by as u8, act.0, 0, None),
                Event::Death { who } => (4.0, who as u8, 0, 0, None),
                Event::MinionSpawned { kind } => (6.0, Side::Boss as u8, kind as u8, 0, None),
                Event::MinionDespawned { kind } => (7.0, Side::Boss as u8, kind as u8, 0, None),
                Event::MinionHit { kind, damage } => {
                    (8.0, Side::Player as u8, kind as u8, damage, None)
                }
                Event::GuardianAbsorbed { amount } => (9.0, Side::Player as u8, 0, amount, None),
                Event::ControllerSlowed { kind } => (10.0, Side::Boss as u8, kind as u8, 1, None),
            };
            let s = shape.map_or([0.0; 6], |s| shape_fields(&s));
            b[o..o + EVENT_STRIDE].copy_from_slice(&[
                kind,
                side as f32,
                act as f32,
                dmg as f32,
                s[0],
                s[1],
                s[2],
                s[3],
                s[4],
                s[5],
            ]);
            o += EVENT_STRIDE;
        }

    }
}

/// Crea un mundo sobre la arena del lanzamiento. Devuelve un puntero opaco que
/// JS guarda y pasa a las demás funciones. Se libera con [`destroy`].
///
#[no_mangle]
pub extern "C" fn create(seed_lo: u32, seed_hi: u32) -> *mut Game {
    let seed = ((seed_hi as u64) << 32) | seed_lo as u64;
    let g = Box::new(Game {
        w: World::new(arena::launch(), seed),
        buf: vec![0.0; STATE_LEN],
        cinta: Vec::new(),
        cabeza: 0,
    });
    let p = Box::into_raw(g);
    // El primer frame tiene que ser legible antes del primer step.
    unsafe { (*p).fill(&StepEvents::default()) };
    p
}

#[no_mangle]
pub extern "C" fn destroy(g: *mut Game) {
    if !g.is_null() {
        unsafe { drop(Box::from_raw(g)) };
    }
}

/// Avanza un tick. `player` y `boss`/`param` vienen empaquetados como en el log.
/// Devuelve 0 si la entrada era inválida y no se avanzó.
///
/// # Safety
/// `g` tiene que venir de [`create`] y no haber pasado por [`destroy`].
#[no_mangle]
pub unsafe extern "C" fn step_tick(g: *mut Game, player: u32, boss: u32, param: u32) -> u32 {
    let g = match g.as_mut() {
        Some(g) => g,
        None => return 0,
    };
    let (input, action) = match (
        log::decode_player(player as u8),
        log::decode_boss(boss as u8, param as u8),
    ) {
        (Ok(i), Ok(a)) => (i, a),
        _ => return 0,
    };
    let ev = step(&mut g.w, input, action);
    g.fill(&ev);
    1
}

/// Puntero al buffer de estado. **Válido hasta el próximo `step_tick`.**
///
/// # Safety
/// `g` tiene que venir de [`create`].
#[no_mangle]
pub unsafe extern "C" fn state_ptr(g: *const Game) -> *const f32 {
    match g.as_ref() {
        Some(g) => g.buf.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn state_len() -> u32 {
    STATE_LEN as u32
}

/// Dimensiones de la arena, para que el render encuadre sin duplicar el dato.
#[no_mangle]
pub extern "C" fn arena_width() -> f32 {
    arena::launch().size.x
}

#[no_mangle]
pub extern "C" fn arena_height() -> f32 {
    arena::launch().size.y
}

/// Cantidad de AABB estáticos de la arena.
#[no_mangle]
pub extern "C" fn arena_statics(g: *const Game) -> u32 {
    unsafe { g.as_ref().map_or(0, |g| g.w.arena.statics.len() as u32) }
}

/// Un estático como `[cx, cy, hx, hy]` en el buffer de estado, reutilizándolo
/// antes del primer frame. La geometría no cambia durante la pelea, así que el
/// render la lee una sola vez al arrancar.
///
/// # Safety
/// `g` tiene que venir de [`create`] y `i` ser menor que [`arena_statics`].
#[no_mangle]
pub unsafe extern "C" fn arena_static(g: *mut Game, i: u32) -> *const f32 {
    let g = match g.as_mut() {
        Some(g) => g,
        None => return core::ptr::null(),
    };
    match g.w.arena.statics.get(i as usize) {
        Some(s) => {
            let c = s.center();
            g.buf[0..4].copy_from_slice(&[c.x, c.y, c.x - s.min.x, c.y - s.min.y]);
            g.buf.as_ptr()
        }
        None => core::ptr::null(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lo mismo que hace JS: crear, avanzar 600 ticks y leer el buffer.
    #[test]
    fn seiscientos_ticks_dan_posiciones_coherentes() {
        let g = create(1, 0);
        let arena = arena::launch();

        // El jugador camina a la derecha (dir 0), el boss se le acerca (dir 32
        // = 180°). Empaquetado igual que en el log.
        let player = 0x08; // movimiento activo, dirección 0, sin acción
        let boss = 1 << 6 | 32;

        for _ in 0..600 {
            assert_eq!(unsafe { step_tick(g, player, boss, 0) }, 1);
        }

        let s = unsafe { core::slice::from_raw_parts(state_ptr(g), STATE_LEN) };
        assert_eq!(s[0], 600.0);
        let (px, py) = (s[HEADER], s[HEADER + 1]);
        let (bx, by) = (s[HEADER + ACTOR_STRIDE], s[HEADER + ACTOR_STRIDE + 1]);

        for (x, y) in [(px, py), (bx, by)] {
            assert!(x > 0.0 && x < arena.size.x, "x={x} fuera de la arena");
            assert!(y > 0.0 && y < arena.size.y, "y={y} fuera de la arena");
        }
        assert!(px > arena.spawn_player.x, "el jugador no avanzó");
        assert!(bx < arena.spawn_boss.x, "el boss no avanzó");
        assert_eq!(s[3], arena.dynamics.len() as f32);

        destroy(g);
    }

    #[test]
    fn una_entrada_invalida_no_avanza_el_mundo() {
        let g = create(1, 0);
        assert_eq!(unsafe { step_tick(g, 0x70, 0, 0) }, 0, "acción 7 no existe");
        assert_eq!(
            unsafe { step_tick(g, 0, 0xC2, 0) },
            0,
            "kind de apoyo inválido"
        );
        let s = unsafe { core::slice::from_raw_parts(state_ptr(g), STATE_LEN) };
        assert_eq!(s[0], 0.0);
        destroy(g);
    }

    #[test]
    fn la_telegrafia_llega_al_buffer_con_su_forma() {
        let g = create(1, 0);
        // Boss usa el martillo (kind 2, tool 0) apuntando a 0.
        assert_eq!(unsafe { step_tick(g, 0, 2 << 6, 0) }, 1);
        let s = unsafe { core::slice::from_raw_parts(state_ptr(g), STATE_LEN) };
        assert_eq!(s[5], 1.0, "un evento");
        let o = HEADER
            + 2 * ACTOR_STRIDE
            + MAX_PROJ * PROJ_STRIDE
            + MAX_DYN * DYN_STRIDE
            + MAX_MINION_STATE * MINION_STRIDE;
        assert_eq!(s[o], 0.0, "tipo telegrafía");
        assert_eq!(s[o + 4], 1.0, "forma de arco");
        assert_eq!(
            s[o + 9],
            crate::weapons::HAMMER_ARC,
            "semiapertura sin empaquetar"
        );
        destroy(g);
    }

    #[test]
    fn la_geometria_de_la_arena_se_lee_una_vez() {
        let g = create(1, 0);
        // El número exacto no importa —la arena es dato y cambia— pero sí que
        // el cliente los lea todos y no se invente ninguno.
        assert_eq!(arena_statics(g), crate::arena::launch().statics.len() as u32);
        let s = unsafe { core::slice::from_raw_parts(arena_static(g, 0), 4) };
        assert_eq!(s, &[16.0, 8.0, 0.75, 4.0], "muro central sur");
        assert!(unsafe { arena_static(g, 99) }.is_null());
        assert_eq!(arena_width(), 32.0);
        destroy(g);
    }


    #[test]
    fn destruir_un_puntero_nulo_no_rompe() {
        destroy(core::ptr::null_mut());
        assert!(unsafe { state_ptr(core::ptr::null()) }.is_null());
        assert_eq!(unsafe { step_tick(core::ptr::null_mut(), 0, 0, 0) }, 0);
    }
}

// --- Reproducir una pelea grabada -------------------------------------------
// El navegador no decide: recibe. Una pelea producida contra el conectoma en la
// GPU llega como log y se reproduce acá tick a tick, bit a bit igual.

/// Reserva `n` bytes para que JS escriba el log antes de [`load_log`].
#[no_mangle]
pub extern "C" fn alloc(n: u32) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n as usize);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// Libera lo que devolvió [`alloc`].
///
/// # Safety
/// `p` tiene que venir de [`alloc`] con el mismo `n`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: u32) {
    drop(Vec::from_raw_parts(p, 0, n as usize));
}

/// Carga un log y reinicia el mundo sobre su arena y su semilla. Devuelve los
/// ticks que dura, o 0 si el log no decodifica.
///
/// # Safety
/// `g` tiene que venir de [`create`] y `data` apuntar a `len` bytes válidos.
#[no_mangle]
pub unsafe extern "C" fn load_log(g: *mut Game, data: *const u8, len: u32) -> u32 {
    let g = match g.as_mut() {
        Some(g) => g,
        None => return 0,
    };
    let bytes = core::slice::from_raw_parts(data, len as usize);
    let log = match log::decode(bytes) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    let arena = match arena::by_id(log.arena_id) {
        Some(a) => a,
        None => return 0,
    };
    g.w = World::new(arena, log.world_seed);
    g.cinta = log::expand(&log);
    g.cabeza = 0;
    g.fill(&StepEvents::default());
    g.cinta.len() as u32
}

/// Avanza un tick de la pelea cargada. Devuelve 0 cuando la cinta se acabó o el
/// mundo terminó.
///
/// # Safety
/// `g` tiene que venir de [`create`].
#[no_mangle]
pub unsafe extern "C" fn step_log(g: *mut Game) -> u32 {
    let g = match g.as_mut() {
        Some(g) => g,
        None => return 0,
    };
    let Some(&(input, action)) = g.cinta.get(g.cabeza) else {
        return 0;
    };
    if g.w.over() {
        return 0;
    }
    g.cabeza += 1;
    let ev = step(&mut g.w, input, action);
    g.fill(&ev);
    1
}

#[cfg(test)]
mod reproduccion {
    use super::*;

    /// Reproducir el log de la pelea guionada tiene que dar **el mismo mundo**
    /// que simularla en nativo. Es el golden test cruzando la frontera del
    /// binding: si esto falla, grabar en la GPU y reproducir en el navegador
    /// dejó de ser la misma pelea.
    #[test]
    fn la_cinta_reproduce_la_pelea_bit_a_bit() {
        let esperado = crate::hash_world(&crate::golden::simulate(&crate::golden::script()));
        let bytes = log::encode(&crate::golden::script());

        let g = create(0, 0);
        let ticks = unsafe { load_log(g, bytes.as_ptr(), bytes.len() as u32) };
        assert!(ticks > 1500, "la cinta dura {ticks} ticks");
        while unsafe { step_log(g) } == 1 {}

        let w = unsafe { &(*g).w };
        assert_eq!(crate::hash_world(w), esperado, "la reproducción diverge");
        destroy(g);
    }

    #[test]
    fn un_log_ilegible_no_carga() {
        let g = create(0, 0);
        assert_eq!(unsafe { load_log(g, [0u8; 8].as_ptr(), 8) }, 0);
        destroy(g);
    }
}
