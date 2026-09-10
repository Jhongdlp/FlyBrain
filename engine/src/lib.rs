//! Motor de combate. Función pura: sin I/O, sin estado global, sin aleatoriedad
//! fuera del `Rng` del `World`, paso fijo.
//!
//! Un crate, dos consumidores: wasm (navegador) y pyo3 (el conectoma, vía
//! `python::VecEnv`). Nunca dos implementaciones que puedan divergir.
//!
//! **El motor no decide la acción del boss: la recibe.** Ése es el único punto
//! donde se enchufa un cerebro, sea el que sea.

pub mod actor;
pub mod arena;
pub mod collision;
pub mod golden;
pub mod log;
pub mod minions;
#[cfg(feature = "python")]
pub mod python;
pub mod raycast;
pub mod rng;
pub mod types;
pub mod wasm;
pub mod weapons;

pub use rng::Rng;
pub use types::*;

/// EL contrato. Todo el juego pasa por acá.
///
/// El motor no elige la acción del boss: la recibe. Quién la decide (el
/// conectoma, una red, un script de test) es problema de quien llama.
pub fn step(w: &mut World, input: PlayerInput, action: BossAction) -> StepEvents {
    let mut ev = StepEvents::default();
    if w.over() {
        return ev;
    }

    // 1. Timers de estado y cooldowns.
    let pt = actor::advance(&mut w.player, actor::player_table);
    let bt = actor::advance(&mut w.boss, weapons::boss_table);
    minions::step(w, &mut ev);

    // 2. Fases activas que arrancan este tick. Antes de la intención: un ataque
    //    ya comprometido se resuelve aunque el actor pida otra cosa.
    if let actor::Transition::ToActive { act, param } = pt {
        if let Some(a) = PlayerAction::from_u8(act.0) {
            weapons::resolve_player(w, a, param, &mut ev);
        }
    }
    if let actor::Transition::ToActive { act, param } = bt {
        if let Some(t) = ToolId::from_u8(act.0) {
            weapons::resolve_boss(w, t, param, &mut ev);
        }
    }

    // 3. Intención. `try_start` y `begin` se encargan de descartarla si el actor
    //    está comprometido o en cooldown.
    if w.player.state == ActorState::Idle && input.move_dir.len_sq() > 0.0 {
        w.player.facing = input.move_dir.angle();
    }
    if let Some(a) = input.action {
        // El cañón del jugador apunta al boss; el resto sale del `facing`, que
        // lo pone el movimiento.
        //
        // **No es asistencia, es una consecuencia del espacio de acciones.** El
        // jugador solo tiene ocho direcciones, y ocho direcciones no alcanzan
        // para apuntar un proyectil: el error de cuantización llega a 22.5°,
        // que a ocho unidades son 3.3 de desvío contra un blanco de 1.2. Medido
        // con el `facing` crudo: 400 disparos, **cero impactos**, y en 400
        // peleas ni un solo tick en que el disparo amenazara al boss.
        //
        // Fijar el blanco mueve la habilidad de "apuntar" a "cuándo disparar
        // —a qué distancia, y con el boss comprometido en qué—", que es lo que
        // el teclado sí puede expresar. Y del otro lado deja que si el disparo
        // entra o no dependa **solo de cómo esquive el boss**, que es
        // exactamente lo que queremos que aprenda.
        let param = if a == PlayerAction::Ability {
            w.boss.pos.sub(w.player.pos).angle()
        } else {
            w.player.facing
        };
        weapons::begin_player(&mut w.player, a, param, &mut ev);
    }
    if let BossAction::Use(t, param) = action {
        weapons::begin(&mut w.boss, t, param, &mut ev);
    }
    if let BossAction::Deploy(kind, param) = action {
        minions::deploy(w, kind, param, &mut ev);
    }

    // 4. Movimiento. Un actor comprometido no acelera, pero la fricción le
    //    sigue corriendo: por eso se llama igual con dirección nula.
    let pdir = if actor::locked(&w.player) {
        Vec2::ZERO
    } else {
        input.move_dir
    };
    // El campo del controlador es **locomoción**, no fricción. Se aplicaba dos
    // veces —escalando la dirección y otra vez la velocidad, cada tick— y eso
    // convertía un 45% nominal en un 78% real: con `DAMP` de 0.86, multiplicar
    // la velocidad por 0.55 todos los ticks deja el tope del jugador en 1.6 de
    // 7. Se sentía como pisar pegamento sin causa visible, que es exactamente
    // lo que el campo no tiene que ser.
    let lento = minions::controller_slow(w).map_or(1.0, |(_, s)| 1.0 - s);
    actor::apply_move(
        &mut w.player,
        pdir,
        actor::PLAYER_ACCEL * lento,
        actor::PLAYER_MAX_SPEED * lento,
    );
    minions::emit_effects(w, &mut ev);

    let bdir = match action {
        BossAction::Move(d) if !actor::locked(&w.boss) => {
            w.boss.facing = d.angle();
            d
        }
        _ => Vec2::ZERO,
    };
    actor::apply_move(&mut w.boss, bdir, actor::BOSS_ACCEL, actor::BOSS_MAX_SPEED);

    // 5. Integración.
    actor::integrate(&mut w.player);
    actor::integrate(&mut w.boss);

    // 6. Colisiones. Actores primero, después cajas, y la arena al final para
    //    que nadie termine fuera por culpa de un empuje.
    collision::resolve_actors(&mut w.player, &mut w.boss);
    for d in &mut w.dynamics {
        collision::resolve_actor_dyn(&mut w.player, d);
        collision::resolve_actor_dyn(&mut w.boss, d);
        collision::resolve_dyn_arena(d, &w.arena);
    }
    collision::resolve_actor_arena(&mut w.player, &w.arena);
    collision::resolve_actor_arena(&mut w.boss, &w.arena);

    // 7. Proyectiles: mueven, cobran, y emiten el whiff del cañón al morir.
    weapons::step_projectiles(w, &mut ev);

    w.tick += 1;
    ev
}

/// Hash del mundo entero. Es lo que compara el golden test de determinismo y lo
/// que delata una transcendental de plataforma colada en la simulación.
///
/// FNV-1a sobre los bits de cada campo: los `f32` entran por `to_bits`, así que
/// dos mundos que difieren en el último bit de una posición dan hashes
/// distintos. Es exactamente la sensibilidad que se busca.
pub fn hash_world(w: &World) -> u64 {
    let mut h = Fnv(0xcbf2_9ce4_8422_2325);
    h.u32(w.tick);
    h.u64(w.rng.state());
    for a in [&w.player, &w.boss] {
        h.f32(a.pos.x);
        h.f32(a.pos.y);
        h.f32(a.vel.x);
        h.f32(a.vel.y);
        h.f32(a.facing);
        h.u32(a.hp as u32);
        h.state(&a.state);
        for cd in a.cooldowns {
            h.u32(cd as u32);
        }
    }
    h.u32(w.projectiles.len() as u32);
    for p in &w.projectiles {
        h.f32(p.pos.x);
        h.f32(p.pos.y);
        h.f32(p.vel.x);
        h.f32(p.vel.y);
        h.u32(p.ttl as u32);
        h.u32(p.damage as u32);
    }
    h.u32(w.dynamics.len() as u32);
    for d in &w.dynamics {
        h.f32(d.pos.x);
        h.f32(d.pos.y);
        h.f32(d.vel.x);
        h.f32(d.vel.y);
    }
    h.u32(w.minion_cooldowns.len() as u32);
    for cd in w.minion_cooldowns {
        h.u32(cd as u32);
    }
    h.u32(w.minions.len() as u32);
    for m in &w.minions {
        h.f32(m.pos.x);
        h.f32(m.pos.y);
        h.f32(m.vel.x);
        h.f32(m.vel.y);
        h.f32(m.radius);
        h.u32(m.hp as u32);
        h.u8(m.kind as u8);
        h.u32(m.ttl as u32);
        h.u32(m.cooldown as u32);
    }
    h.0
}

struct Fnv(u64);

impl Fnv {
    fn u8(&mut self, b: u8) {
        self.0 = (self.0 ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    fn u32(&mut self, v: u32) {
        for b in v.to_le_bytes() {
            self.u8(b);
        }
    }
    fn u64(&mut self, v: u64) {
        for b in v.to_le_bytes() {
            self.u8(b);
        }
    }
    fn f32(&mut self, v: f32) {
        self.u32(v.to_bits());
    }
    fn state(&mut self, s: &ActorState) {
        let (tag, act, param, a, b) = match *s {
            ActorState::Idle => (0, 0, 0.0, 0, 0),
            ActorState::Windup {
                act,
                param,
                ticks_left,
            } => (1, act.0, param, ticks_left, 0),
            ActorState::Active {
                act,
                param,
                ticks_left,
            } => (2, act.0, param, ticks_left, 0),
            ActorState::Recovery { ticks_left } => (3, 0, 0.0, ticks_left, 0),
            ActorState::Dodging {
                ticks_left,
                iframes_left,
            } => (4, 0, 0.0, ticks_left, iframes_left),
        };
        self.u8(tag);
        self.u8(act);
        self.f32(param);
        self.u32(a as u32);
        self.u32(b as u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Arena de prueba mínima. La real la entrega T3.
    fn arena_test() -> Arena {
        Arena {
            id: 0,
            seed: 1,
            size: Vec2::new(20.0, 20.0),
            statics: Vec::new(),
            spawn_player: Vec2::new(4.0, 10.0),
            spawn_boss: Vec2::new(16.0, 10.0),
            dynamics: Vec::new(),
        }
    }

    #[test]
    fn sesenta_ticks_sin_panico() {
        let mut w = World::new(arena_test(), 12345);
        for _ in 0..60 {
            let ev = step(&mut w, PlayerInput::default(), BossAction::Idle);
            assert!(ev.is_empty());
        }
        assert_eq!(w.tick, 60);
    }

    /// El invariante del proyecto, en su forma más chica. T7 lo hace en serio.
    #[test]
    fn misma_semilla_mismo_mundo() {
        let run = || {
            let mut w = World::new(arena_test(), 999);
            for _ in 0..60 {
                step(&mut w, PlayerInput::default(), BossAction::Idle);
            }
            w
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn dt_es_fijo() {
        assert_eq!(DT, 1.0 / 60.0);
    }

    #[test]
    fn controller_reduce_el_movimiento_y_emite_exposicion() {
        let mut w = World::new(arena_test(), 1);
        w.player.pos = Vec2::new(10.0, 10.0);
        w.boss.pos = Vec2::new(12.0, 10.0);
        let mut setup = StepEvents::default();
        minions::deploy(
            &mut w,
            MinionKind::Controller,
            core::f32::consts::PI,
            &mut setup,
        );
        w.minions[0].pos = w.player.pos;
        let ev = step(
            &mut w,
            PlayerInput {
                move_dir: Vec2::new(1.0, 0.0),
                action: None,
            },
            BossAction::Idle,
        );
        assert!(w.player.vel.x < actor::PLAYER_MAX_SPEED);
        assert!(ev
            .events
            .iter()
            .any(|e| matches!(e, Event::ControllerSlowed { .. })));
    }

    #[test]
    fn hash_incluye_el_estado_de_los_minions() {
        let a = World::new(arena_test(), 7);
        let mut b = a.clone();
        let mut ev = StepEvents::default();
        minions::deploy(&mut b, MinionKind::Guardian, 0.0, &mut ev);
        assert_ne!(hash_world(&a), hash_world(&b));
        assert_eq!(hash_world(&a), hash_world(&a.clone()));
    }
}
