//! T4 — Movimiento y la máquina de estados que comparten jugador y boss.
//!
//! `Idle → Windup → Active → Recovery → Idle`, más `Dodging`. Una sola
//! implementación para los dos actores: el slot (`ActId`) lo interpreta cada
//! uno contra su propia tabla de frame data — la del jugador vive acá, la del
//! boss en `weapons.rs`.
//!
//! La tabla se pasa como parámetro en vez de guardarse en el `Actor`. Así el
//! frame data no entra en el estado del mundo, que es lo que T7 hashea y T6
//! serializa: los ticks de una animación son configuración, no simulación.

use crate::types::{ActId, Actor, ActorState, PlayerAction, Vec2, DT};

// --- Perillas de calibración -------------------------------------------------
// Todo lo de acá se afina jugando, no razonando. Está junto para que afinarlo
// sea editar un bloque y no cazar constantes por el repo.

/// Fracción de velocidad que sobrevive a un tick. Con la aceleración de abajo
/// da un frenado de ~5 ticks: responde sin patinar.
pub const DAMP: f32 = 0.86;

pub const PLAYER_ACCEL: f32 = 90.0;
pub const PLAYER_MAX_SPEED: f32 = 7.0;
pub const BOSS_ACCEL: f32 = 55.0;
pub const BOSS_MAX_SPEED: f32 = 4.5;

/// Ticks y geometría de una acción. `dash` e `iframes` son lo que separa una
/// esquiva de un ataque sin necesidad de una rama por actor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frames {
    pub windup: u16,
    pub active: u16,
    pub recovery: u16,
    pub cooldown: u16,
    /// Velocidad del impulso inicial, en la dirección de `param`. 0 = ninguno.
    pub dash: f32,
    /// > 0 convierte la acción en esquiva: entra en `Dodging`, dura `active`
    /// ticks y es invulnerable durante los primeros `iframes`.
    pub iframes: u16,
}

impl Frames {
    pub const fn attack(windup: u16, active: u16, recovery: u16, cooldown: u16) -> Self {
        Frames { windup, active, recovery, cooldown, dash: 0.0, iframes: 0 }
    }
    /// Ticks que el actor queda comprometido, de principio a fin.
    pub fn total(&self) -> u16 {
        if self.iframes > 0 {
            self.active
        } else {
            self.windup + self.active + self.recovery
        }
    }
}

/// Tabla de frame data: `ActId` → `Frames`. Un puntero a función, no un trait:
/// hay exactamente dos tablas y ninguna necesita estado.
pub type Table = fn(ActId) -> Frames;

/// Frame data del jugador. Cerrada: atacar, esquivar, parry, habilidad.
pub fn player_frames(a: PlayerAction) -> Frames {
    match a {
        // Cooldown = total: al ataque básico lo limita su propio recovery,
        // no un timer aparte. El cooldown empieza a correr en `try_start`,
        // así que solo se nota cuando supera la duración de la acción.
        PlayerAction::Attack => Frames::attack(8, 4, 12, 24),
        PlayerAction::Dodge => Frames {
            windup: 0,
            active: 18,
            recovery: 0,
            cooldown: 45,
            dash: 14.0,
            // Los últimos 6 ticks del dodge ya son vulnerables: esquivar tiene
            // que costar algo o se vuelve la única respuesta correcta.
            iframes: 12,
        },
        PlayerAction::Parry => Frames::attack(3, 8, 20, 40),
        PlayerAction::Ability => Frames::attack(14, 6, 20, 180),
    }
}

/// La tabla del jugador como `Table`.
pub fn player_table(act: ActId) -> Frames {
    debug_assert!(PlayerAction::from_u8(act.0).is_some(), "slot fuera de rango");
    player_frames(PlayerAction::from_u8(act.0).unwrap_or(PlayerAction::Attack))
}

/// Lo que cambió de fase en este tick. Es el gancho que usa `weapons.rs`:
/// `ToActive` dispara el golpe o el proyectil, `ToRecovery` es donde se decide
/// si hubo whiff.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Transition {
    None,
    ToActive { act: ActId, param: f32 },
    ToRecovery { act: ActId, param: f32 },
    ToIdle,
}

/// Un tick de timers: cooldowns y fase actual.
pub fn advance(a: &mut Actor, table: Table) -> Transition {
    for cd in a.cooldowns.iter_mut() {
        *cd = cd.saturating_sub(1);
    }

    match a.state {
        ActorState::Idle => Transition::None,

        ActorState::Windup { act, param, ticks_left } => {
            let t = ticks_left - 1;
            if t > 0 {
                a.state = ActorState::Windup { act, param, ticks_left: t };
                Transition::None
            } else {
                enter_active(a, act, param, table(act))
            }
        }

        ActorState::Active { act, param, ticks_left } => {
            let t = ticks_left - 1;
            if t > 0 {
                a.state = ActorState::Active { act, param, ticks_left: t };
                Transition::None
            } else {
                enter_recovery(a, act, param, table(act))
            }
        }

        ActorState::Recovery { ticks_left } => {
            let t = ticks_left - 1;
            if t > 0 {
                a.state = ActorState::Recovery { ticks_left: t };
                Transition::None
            } else {
                a.state = ActorState::Idle;
                Transition::ToIdle
            }
        }

        ActorState::Dodging { ticks_left, iframes_left } => {
            let t = ticks_left - 1;
            let inv = iframes_left.saturating_sub(1);
            if t > 0 {
                a.state = ActorState::Dodging { ticks_left: t, iframes_left: inv };
                Transition::None
            } else {
                a.state = ActorState::Idle;
                Transition::ToIdle
            }
        }
    }
}

/// Las fases de duración cero se saltan: una tabla con `active: 0` no deja al
/// actor trabado un tick de más.
fn enter_active(a: &mut Actor, act: ActId, param: f32, f: Frames) -> Transition {
    // El impulso arranca con la fase activa, no con el windup: si el boss se
    // moviera durante la telegrafía, la telegrafía no serviría de nada.
    if f.dash > 0.0 {
        a.vel = Vec2::from_angle(param).scale(f.dash);
    }
    if f.active > 0 {
        a.state = ActorState::Active { act, param, ticks_left: f.active };
        Transition::ToActive { act, param }
    } else {
        enter_recovery(a, act, param, f)
    }
}

fn enter_recovery(a: &mut Actor, act: ActId, param: f32, f: Frames) -> Transition {
    a.state = if f.recovery > 0 {
        ActorState::Recovery { ticks_left: f.recovery }
    } else {
        ActorState::Idle
    };
    Transition::ToRecovery { act, param }
}

/// Intenta iniciar una acción. Falla si el actor no está en `Idle` o si el
/// cooldown del slot no bajó.
///
/// Una acción pedida durante `Recovery` se descarta y se pierde: sin input
/// buffer en el MVP.
/// `ponytail: sin buffer ni cancelación de animación. Es el arreglo más
/// probable si el combate se siente tosco en el paso 2.`
pub fn try_start(a: &mut Actor, act: ActId, param: f32, f: Frames) -> bool {
    if a.state != ActorState::Idle || a.cooldowns[act.0 as usize] > 0 {
        return false;
    }
    a.cooldowns[act.0 as usize] = f.cooldown;

    if f.iframes > 0 {
        // La esquiva no telegrafía: es reacción, y su impulso es inmediato.
        if f.dash > 0.0 {
            a.vel = Vec2::from_angle(param).scale(f.dash);
        }
        a.state = ActorState::Dodging { ticks_left: f.active, iframes_left: f.iframes };
    } else if f.windup > 0 {
        a.state = ActorState::Windup { act, param, ticks_left: f.windup };
    } else {
        enter_active(a, act, param, f);
    }
    true
}

#[cfg(test)]
mod tests_impulso {
    use super::*;
    use crate::types::{ActId, Actor, PlayerAction, Vec2, PLAYER_HP, PLAYER_RADIUS};

    /// Cuánto recorre un actor en `ticks` sin acelerar, solo con lo que le dio
    /// el impulso. Es lo que el jugador ve como "la esquiva me movió".
    fn recorrido(f: Frames, max_speed: f32) -> f32 {
        let mut a = Actor::new(Vec2::ZERO, PLAYER_RADIUS, PLAYER_HP);
        assert!(try_start(&mut a, ActId(0), 0.0, f), "no arrancó");
        for _ in 0..f.active {
            apply_move(&mut a, Vec2::ZERO, 0.0, max_speed);
            integrate(&mut a);
        }
        a.pos.x
    }

    /// **Un impulso tiene que mover más que caminar, o no es un impulso.**
    ///
    /// El tope de velocidad se aplicaba también a los dashes, así que los tres
    /// del juego morían en el tick en que se daban — el del boss arrancaba a 16
    /// y quedaba en 4.5, que es su velocidad de caminar: esquivaba sin moverse.
    /// No daba error, no rompía ningún test, y en pantalla parecía que la
    /// animación estaba mal.
    #[test]
    fn un_dash_desplaza_mucho_mas_que_caminar() {
        let dodge = player_frames(PlayerAction::Dodge);
        let andando = PLAYER_MAX_SPEED * dodge.active as f32 * DT;
        let d = recorrido(dodge, PLAYER_MAX_SPEED);
        assert!(d > 0.0, "la esquiva no movió nada");
        // No pide un número exacto —es una perilla— sino que el impulso se note
        // frente a su propio tope de velocidad.
        assert!(
            d > andando * 0.4,
            "la esquiva del jugador recorre {d:.2}, casi lo mismo que caminar ({andando:.2})"
        );

        // Y el del boss, que es el que se veía sin moverse.
        let dash = crate::weapons::frames(crate::types::ToolId::Dash);
        let db = recorrido(dash, crate::actor::BOSS_MAX_SPEED);
        assert!(
            db > BOSS_MAX_SPEED * dash.active as f32 * DT * 0.8,
            "la esquiva del boss recorre {db:.2}: se está comiendo el tope de velocidad"
        );
    }
}

/// El actor está comprometido en una acción y no acepta input de movimiento.
/// La esquiva incluida: su impulso ya lo dio `try_start`.
pub fn locked(a: &Actor) -> bool {
    a.state != ActorState::Idle
}

pub fn invulnerable(a: &Actor) -> bool {
    matches!(a.state, ActorState::Dodging { iframes_left, .. } if iframes_left > 0)
}

/// Aceleración, fricción y tope de velocidad, en ese orden. `dir` viene
/// normalizado o nulo.
///
/// Nunca velocidad instantánea: el peso del movimiento es lo que hace legible
/// el compromiso de un ataque.
pub fn apply_move(a: &mut Actor, dir: Vec2, accel: f32, max_speed: f32) {
    // Lo que le queda al actor si no acelera: solo fricción. Es el techo cuando
    // viene lanzado, porque un impulso ya ganado no se le puede quitar.
    let inercia = a.vel.scale(DAMP).len();
    a.vel = a.vel.add(dir.scale(accel * DT)).scale(DAMP);
    let s2 = a.vel.len_sq();
    // **El tope es de locomoción, no de impulsos**: limita lo que la
    // aceleración puede conseguir, no lo que un dash ya consiguió.
    //
    // Clampeando contra `max_speed` a secas, los tres impulsos del juego
    // desaparecían en el mismo tick en que se daban: la esquiva del boss
    // arrancaba a 16 y quedaba en 4.5, que es **exactamente su velocidad de
    // caminar** —esquivaba sin moverse—, la del jugador iba de 14 a 7, y la
    // embestida de 45 a 4.5. Ninguno de los tres hacía lo que su tabla decía.
    //
    // Con la inercia como techo, la fricción es la que frena el impulso: cae
    // sola en ~15 ticks y el actor vuelve a su tope normal sin ningún caso
    // especial ni bandera de "estoy dasheando".
    let tope = max_speed.max(inercia);
    if s2 > tope * tope {
        a.vel = a.vel.scale(tope / s2.sqrt());
    }
}

/// Integra la posición. La colisión la resuelve `collision.rs` después.
pub fn integrate(a: &mut Actor) {
    a.pos = a.pos.add(a.vel.scale(DT));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PLAYER_HP, PLAYER_RADIUS};

    fn jugador() -> Actor {
        Actor::new(Vec2::ZERO, PLAYER_RADIUS, PLAYER_HP)
    }

    /// Cuenta cuántos ticks pasa el actor en cada fase, de punta a punta.
    fn duraciones(a: &mut Actor) -> (u16, u16, u16) {
        let (mut w, mut act, mut rec) = (0, 0, 0);
        for _ in 0..600 {
            match a.state {
                ActorState::Windup { .. } => w += 1,
                ActorState::Active { .. } => act += 1,
                ActorState::Recovery { .. } => rec += 1,
                ActorState::Idle => break,
                ActorState::Dodging { .. } => {}
            }
            advance(a, player_table);
        }
        (w, act, rec)
    }

    #[test]
    fn cada_fase_dura_sus_ticks_exactos() {
        let f = player_frames(PlayerAction::Attack);
        let mut a = jugador();
        assert!(try_start(&mut a, PlayerAction::Attack.act(), 0.0, f));
        assert_eq!(duraciones(&mut a), (f.windup, f.active, f.recovery));
        assert_eq!(a.state, ActorState::Idle);
    }

    #[test]
    fn las_transiciones_llegan_en_el_tick_correcto() {
        let f = player_frames(PlayerAction::Attack);
        let mut a = jugador();
        let act = PlayerAction::Attack.act();
        try_start(&mut a, act, 1.0, f);

        for _ in 0..f.windup - 1 {
            assert_eq!(advance(&mut a, player_table), Transition::None);
        }
        assert_eq!(advance(&mut a, player_table), Transition::ToActive { act, param: 1.0 });

        for _ in 0..f.active - 1 {
            assert_eq!(advance(&mut a, player_table), Transition::None);
        }
        assert_eq!(advance(&mut a, player_table), Transition::ToRecovery { act, param: 1.0 });

        for _ in 0..f.recovery - 1 {
            assert_eq!(advance(&mut a, player_table), Transition::None);
        }
        assert_eq!(advance(&mut a, player_table), Transition::ToIdle);
    }

    #[test]
    fn las_fases_de_cero_ticks_se_saltan() {
        let f = Frames::attack(0, 0, 5, 10);
        let mut a = jugador();
        try_start(&mut a, ActId(0), 0.0, f);
        assert_eq!(a.state, ActorState::Recovery { ticks_left: 5 });
    }

    #[test]
    fn el_dodge_da_iframes_en_su_ventana_y_no_fuera() {
        let f = player_frames(PlayerAction::Dodge);
        let mut a = jugador();
        assert!(try_start(&mut a, PlayerAction::Dodge.act(), 0.0, f));

        for i in 0..f.iframes {
            assert!(invulnerable(&a), "tick {i} debería ser invulnerable");
            advance(&mut a, player_table);
        }
        // Sigue esquivando pero ya expuesto: la ventana cierra antes que el dodge.
        assert!(!invulnerable(&a));
        assert!(matches!(a.state, ActorState::Dodging { .. }));

        for _ in f.iframes..f.active {
            assert!(!invulnerable(&a));
            advance(&mut a, player_table);
        }
        assert_eq!(a.state, ActorState::Idle);
        assert!(!invulnerable(&a));
    }

    fn tabla_dash(_: ActId) -> Frames {
        Frames { dash: 45.0, ..Frames::attack(10, 6, 4, 60) }
    }

    /// Una acción con windup no se mueve hasta que la fase activa empieza.
    #[test]
    fn el_dash_espera_al_windup() {
        let f = tabla_dash(ActId(0));
        let mut a = jugador();
        try_start(&mut a, ActId(0), 0.0, f);
        for _ in 0..f.windup - 1 {
            advance(&mut a, tabla_dash);
            assert_eq!(a.vel, Vec2::ZERO, "quieto mientras telegrafía");
        }
        advance(&mut a, tabla_dash);
        assert_eq!(a.vel, Vec2::new(45.0, 0.0));
    }

    #[test]
    fn el_dodge_impulsa_en_la_direccion_del_parametro() {
        let f = player_frames(PlayerAction::Dodge);
        let mut a = jugador();
        try_start(&mut a, PlayerAction::Dodge.act(), 0.0, f); // ángulo 0 = +x
        assert_eq!(a.vel, Vec2::new(f.dash, 0.0));
    }

    #[test]
    fn una_accion_durante_recovery_no_tiene_efecto() {
        let f = player_frames(PlayerAction::Attack);
        let mut a = jugador();
        try_start(&mut a, PlayerAction::Attack.act(), 0.0, f);
        for _ in 0..f.windup + f.active {
            advance(&mut a, player_table);
        }
        assert!(matches!(a.state, ActorState::Recovery { .. }));

        let antes = a.state;
        let p = player_frames(PlayerAction::Parry);
        assert!(!try_start(&mut a, PlayerAction::Parry.act(), 0.0, p));
        assert_eq!(a.state, antes);
        assert_eq!(a.cooldowns[PlayerAction::Parry as usize], 0, "no consume cooldown");
    }

    #[test]
    fn el_cooldown_baja_un_tick_por_step_y_bloquea_la_repeticion() {
        // Habilidad: 40 ticks de acción, 180 de cooldown. El hueco es real.
        let f = player_frames(PlayerAction::Ability);
        let slot = PlayerAction::Ability.act();
        let mut a = jugador();
        try_start(&mut a, slot, 0.0, f);
        assert_eq!(a.cooldowns[slot.0 as usize], f.cooldown);

        for _ in 0..f.total() {
            advance(&mut a, player_table);
        }
        assert_eq!(a.state, ActorState::Idle);
        assert_eq!(a.cooldowns[slot.0 as usize], f.cooldown - f.total());
        assert!(!try_start(&mut a, slot, 0.0, f), "el cooldown sigue corriendo");

        for _ in 0..f.cooldown - f.total() {
            advance(&mut a, player_table);
        }
        assert_eq!(a.cooldowns[slot.0 as usize], 0);
        assert!(try_start(&mut a, slot, 0.0, f));
    }

    /// El ataque básico se encadena en cuanto termina: lo limita el recovery.
    #[test]
    fn el_ataque_basico_no_tiene_hueco_muerto() {
        let f = player_frames(PlayerAction::Attack);
        assert_eq!(f.cooldown, f.total());
        let mut a = jugador();
        try_start(&mut a, PlayerAction::Attack.act(), 0.0, f);
        for _ in 0..f.total() {
            advance(&mut a, player_table);
        }
        assert!(try_start(&mut a, PlayerAction::Attack.act(), 0.0, f));
    }

    /// Valores exactos en binario: 60/60 = 1, y el resto son mitades.
    #[test]
    fn la_velocidad_acelera_y_frena_sin_saltos() {
        let mut a = jugador();
        // accel 60 con DT=1/60 da exactamente 1.0 de delta por tick.
        apply_move(&mut a, Vec2::new(1.0, 0.0), 60.0, 100.0);
        assert_eq!(a.vel, Vec2::new(DAMP, 0.0), "no hay velocidad instantánea");
        apply_move(&mut a, Vec2::new(1.0, 0.0), 60.0, 100.0);
        assert_eq!(a.vel, Vec2::new((DAMP + 1.0) * DAMP, 0.0));

        for _ in 0..200 {
            apply_move(&mut a, Vec2::ZERO, 0.0, 100.0);
        }
        assert!(a.vel.len() < 1e-6, "la fricción lo frena sola");
    }

    /// El tope limita **la aceleración**, no la velocidad que ya se tiene.
    ///
    /// Antes cortaba las dos cosas, y con eso mataba los tres impulsos del
    /// juego en el tick en que se daban: la esquiva del boss pasaba de 16 a 4.5
    /// —su velocidad de caminar— y por eso en pantalla esquivaba sin moverse.
    #[test]
    fn la_velocidad_se_topea() {
        // Acelerando desde quieto no se pasa del tope, por mucho que insista.
        let mut a = jugador();
        for _ in 0..600 {
            apply_move(&mut a, Vec2::new(1.0, 0.0), 90.0, 3.0);
        }
        assert!(a.vel.len() <= 3.0 + 1e-4, "la aceleración se pasó del tope: {:?}", a.vel);
    }

    /// Y un impulso por encima del tope lo frena la fricción, no el tijeretazo.
    #[test]
    fn un_impulso_no_lo_corta_el_tope_sino_la_friccion() {
        let mut a = jugador();
        a.vel = Vec2::new(10.0, 0.0);
        apply_move(&mut a, Vec2::ZERO, 0.0, 3.0);
        assert_eq!(a.vel, Vec2::new(10.0 * DAMP, 0.0), "el tope se comió el impulso");

        // Pero converge al tope solo, sin caso especial ni bandera de estado.
        for _ in 0..60 {
            apply_move(&mut a, Vec2::new(1.0, 0.0), 90.0, 3.0);
        }
        assert!(a.vel.len() <= 3.0 + 1e-4, "no volvió al tope: {:?}", a.vel);
    }

    #[test]
    fn integrar_usa_el_paso_fijo() {
        let mut a = jugador();
        a.vel = Vec2::new(60.0, 0.0);
        integrate(&mut a);
        assert_eq!(a.pos, Vec2::new(1.0, 0.0));
    }
}
