//! T10 — Entorno vectorizado para entrenar desde Python.
//!
//! **La API es batcheada, no un `step()` por llamada.** Un step por llamada hace
//! que el overhead de FFI se coma la ventaja de Rust entera y termine más lento
//! que Node. Una llamada avanza N arenas en paralelo con rayon y devuelve
//! observaciones, recompensas y flags de fin en arrays contiguos.
//!
//! Las acciones llegan **con el mismo empaquetado que el log y que el binding
//! wasm**: entrenar y jugar consumen exactamente los mismos valores discretos.
//!
//! Determinismo: cada entorno tiene su propio `Rng` y no comparte nada, así que
//! el paralelismo de rayon no cambia el resultado. `mismo_seed_mismo_resultado`
//! lo verifica.

use numpy::{PyArray1, PyArray2, PyArrayMethods, PyReadonlyArray2, PyUntypedArrayMethods};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use rayon::prelude::*;

use crate::actor;
use crate::log;
use crate::raycast::{self, N_RAYS};
use crate::rng::Rng;
use crate::types::*;
use crate::{arena, step};

/// 16 rayos + 2 de línea de visión + 10 del jugador + (4 + N_TOOLS) del boss +
/// 6 globales. Nunca píxeles: multiplican por mil el costo de muestras.
///
/// El bloque del boss se escribe en función de `N_TOOLS` y no con índices a
/// mano: la quinta herramienta pisó el hueco de `fase` cuando eran fijos.
/// vida + un cooldown por herramienta + fase, ticks restantes y borde.
const OBS_BOSS: usize = 4 + N_TOOLS;
pub const OBS_DIM: usize = N_RAYS + 2 + 10 + OBS_BOSS + 6;

/// Con qué se divide la señal de looming para que caiga en [0,1] casi siempre.
/// El cañón del jugador a punto de impactar da ~2 rad/s.
pub const LOOMING_REF: f32 = 3.0;

/// Tope de una pelea de entrenamiento.
pub const EPISODE_TICKS: u32 = 3600;

// --- Recompensa densa --------------------------------------------------------
// Sin esto el crédito terminal escaso hace todo 100x más lento. Perillas: se
// afinan mirando qué política sale, no razonando.

/// Por punto de vida quitado al jugador. Matarlo (100 hp) vale 1.0.
pub const R_DANO: f32 = 0.01;
/// Por punto de vida recibido. El boss tiene 1000, así que morir vale -1.0.
pub const R_RECIBIDO: f32 = 0.001;
/// Por ataque que no toca a nadie. **Este es el término que enseña a usar las
/// herramientas**: sin él, el boss no distingue apuntar de no apuntar.
pub const R_WHIFF: f32 = 0.05;
/// Por tick. El fallo clásico esperado es que el boss aprenda a quedarse quieto
/// en un rincón porque no recibir daño sale más barato que atacar.
pub const R_PASIVIDAD: f32 = 0.0005;
pub const R_TERMINAL: f32 = 1.0;

struct Env {
    w: World,
    rng: Rng,
    /// Media móvil del daño neto reciente. Es el "momentum" del estado global.
    momentum: f32,
    /// Últimas tres acciones del jugador. En 60 segundos es toda la memoria que
    /// importa: no hacen falta ni LSTM ni transformers.
    ultimas: [f32; 3],
}

impl Env {
    fn new(seed: u64) -> Self {
        let mut rng = Rng::new(seed);
        let w = World::new(arena::launch(), rng.next_u32() as u64 | (rng.next_u32() as u64) << 32);
        Env { w, rng, momentum: 0.0, ultimas: [0.0; 3] }
    }

    fn reset(&mut self) {
        let seed = self.rng.next_u32() as u64 | (self.rng.next_u32() as u64) << 32;
        self.w = World::new(arena::launch(), seed);
        self.momentum = 0.0;
        self.ultimas = [0.0; 3];
    }

    /// Egocéntrica: todo lo del jugador va rotado al marco del boss. Así "el
    /// jugador viene por mi derecha" es siempre la misma entrada y la política
    /// generaliza entre mapas en vez de memorizar orientaciones.
    fn observe(&self, o: &mut [f32]) {
        let w = &self.w;
        let diag = w.arena.size.len();

        o[..N_RAYS].copy_from_slice(&raycast::perception(w));
        let (libre, dist) = raycast::line_of_sight(w.boss.pos, w.player.pos, w);
        o[N_RAYS] = libre as u8 as f32;
        o[N_RAYS + 1] = dist / diag;

        let fwd = Vec2::from_angle(w.boss.facing);
        let rel = w.player.pos.sub(w.boss.pos);
        let vel = w.player.vel.sub(w.boss.vel);
        let (fase_p, ticks_p, slot_p) = fase(&w.player);

        let p = &mut o[N_RAYS + 2..N_RAYS + 12];
        p[0] = rel.dot(fwd) / diag;
        p[1] = rel.dot(fwd.perp()) / diag;
        p[2] = vel.dot(fwd) / actor::PLAYER_MAX_SPEED;
        p[3] = vel.dot(fwd.perp()) / actor::PLAYER_MAX_SPEED;
        p[4] = w.player.hp as f32 / PLAYER_HP as f32;
        p[5] = rel.len() / diag;
        p[6] = fase_p;
        p[7] = ticks_p;
        p[8] = slot_p;
        p[9] = actor::invulnerable(&w.player) as u8 as f32;

        let (fase_b, ticks_b, _) = fase(&w.boss);
        let borde = w
            .boss
            .pos
            .x
            .min(w.boss.pos.y)
            .min(w.arena.size.x - w.boss.pos.x)
            .min(w.arena.size.y - w.boss.pos.y);

        let b = &mut o[N_RAYS + 12..N_RAYS + 12 + OBS_BOSS];
        b[0] = w.boss.hp as f32 / BOSS_HP as f32;
        for i in 0..N_TOOLS {
            b[1 + i] = w.boss.cooldowns[i] as f32 / 256.0;
        }
        b[1 + N_TOOLS] = fase_b;
        b[2 + N_TOOLS] = ticks_b;
        b[3 + N_TOOLS] = borde / diag;

        let g = &mut o[N_RAYS + 12 + OBS_BOSS..OBS_DIM];
        g[0] = w.tick as f32 / EPISODE_TICKS as f32;
        g[1] = self.momentum;
        g[2..5].copy_from_slice(&self.ultimas);
        // La entrada sensorial de la mosca: cuánto crece en el campo visual lo
        // que se le viene encima. Es lo que responden LC4 y LPLC2.
        g[5] = (crate::vision::looming(w) / LOOMING_REF).min(1.0);
    }

    fn step(&mut self, a: &[u8]) -> (f32, bool) {
        let input = log::decode_player(a[0]).unwrap_or_default();
        let action = log::decode_boss(a[1], a[2]).unwrap_or(BossAction::Idle);

        let hp_antes = (self.w.player.hp, self.w.boss.hp);
        let ev = step(&mut self.w, input, action);

        let whiffs = ev
            .events
            .iter()
            .filter(|e| matches!(e, Event::Whiff { by: Side::Boss, .. }))
            .count() as f32;
        let infligido = (hp_antes.0 - self.w.player.hp) as f32;
        let recibido = (hp_antes.1 - self.w.boss.hp) as f32;

        let mut r = R_DANO * infligido - R_RECIBIDO * recibido - R_WHIFF * whiffs - R_PASIVIDAD;
        if !self.w.player.alive() {
            r += R_TERMINAL;
        }
        if !self.w.boss.alive() {
            r -= R_TERMINAL;
        }

        self.momentum = self.momentum * 0.98 + (infligido - recibido) * 0.02;
        if let Some(act) = input.action {
            self.ultimas = [self.ultimas[1], self.ultimas[2], (act as u8 + 1) as f32 / 4.0];
        }

        (r, self.w.over() || self.w.tick >= EPISODE_TICKS)
    }
}

/// `(fase, ticks restantes normalizados, slot)`.
fn fase(a: &Actor) -> (f32, f32, f32) {
    match a.state {
        ActorState::Idle => (0.0, 0.0, 0.0),
        ActorState::Windup { act, ticks_left, .. } => (0.25, ticks_left as f32 / 64.0, act.0 as f32 / 4.0),
        ActorState::Active { act, ticks_left, .. } => (0.5, ticks_left as f32 / 64.0, act.0 as f32 / 4.0),
        ActorState::Recovery { ticks_left } => (0.75, ticks_left as f32 / 64.0, 0.0),
        ActorState::Dodging { ticks_left, iframes_left } => {
            (1.0, ticks_left as f32 / 64.0, iframes_left as f32 / 64.0)
        }
    }
}

/// N arenas avanzando en paralelo. Los buffers se asignan una vez y se rellenan
/// en el lugar; numpy los copia una vez por llamada, no una vez por entorno.
#[pyclass]
pub struct VecEnv {
    envs: Vec<Env>,
    obs: Vec<f32>,
    rew: Vec<f32>,
    done: Vec<bool>,
}

#[pymethods]
impl VecEnv {
    #[new]
    #[pyo3(signature = (n, seed = 0))]
    fn new(n: usize, seed: u64) -> PyResult<Self> {
        if n == 0 {
            return Err(PyValueError::new_err("n tiene que ser > 0"));
        }
        Ok(VecEnv {
            envs: (0..n).map(|i| Env::new(seed ^ (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))).collect(),
            obs: vec![0.0; n * OBS_DIM],
            rew: vec![0.0; n],
            done: vec![false; n],
        })
    }

    #[getter]
    fn num_envs(&self) -> usize {
        self.envs.len()
    }

    #[getter]
    fn obs_dim(&self) -> usize {
        OBS_DIM
    }

    /// Estado crudo: `(n, 9)` con `[px, py, pvx, pvy, bx, by, php, bhp, loom_proy]`.
    ///
    /// **Solo lectura, y no es la observación del cerebro.** Existe para guionar
    /// al oponente en un experimento y para medir resultados; la política del
    /// boss ve `obs`, que es egocéntrica y normalizada. Si una decisión del boss
    /// dependiera de esto, sería una regla de juego viviendo en Python.
    fn world_state<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray2<f32>> {
        let a = PyArray2::<f32>::zeros(py, [self.envs.len(), 9], false);
        let s = unsafe { a.as_slice_mut().unwrap() };
        for (e, o) in self.envs.iter().zip(s.chunks_mut(9)) {
            let w = &e.w;
            o.copy_from_slice(&[
                w.player.pos.x, w.player.pos.y, w.player.vel.x, w.player.vel.y,
                w.boss.pos.x, w.boss.pos.y, w.player.hp as f32, w.boss.hp as f32,
                crate::vision::de_proyectiles(w),
            ]);
        }
        a
    }

    fn reset<'py>(&mut self, py: Python<'py>) -> Bound<'py, PyArray2<f32>> {
        let obs = &mut self.obs;
        self.envs
            .par_iter_mut()
            .zip(obs.par_chunks_mut(OBS_DIM))
            .for_each(|(e, o)| {
                e.reset();
                e.observe(o);
            });
        self.obs_array(py)
    }

    /// `acciones` es `(n, 3)` uint8: `[byte del jugador, byte del boss,
    /// parámetro]`, el mismo empaquetado que el log.
    ///
    /// Los entornos terminados se reinician solos y la observación devuelta ya
    /// es la del episodio nuevo.
    /// `ponytail: se pierde la última observación real del episodio. Importa
    /// para bootstrapping de valor; agregar un 'final_obs' si PPO lo pide.`
    fn step<'py>(
        &mut self,
        py: Python<'py>,
        acciones: PyReadonlyArray2<'py, u8>,
    ) -> PyResult<(Bound<'py, PyArray2<f32>>, Bound<'py, PyArray1<f32>>, Bound<'py, PyArray1<bool>>)>
    {
        let n = self.envs.len();
        let dims = acciones.shape();
        if dims != [n, 3] {
            return Err(PyValueError::new_err(format!(
                "se esperaba ({n}, 3), llegó {dims:?}"
            )));
        }
        let a = acciones.as_slice()?;

        let (envs, obs, rew, done) = (&mut self.envs, &mut self.obs, &mut self.rew, &mut self.done);
        py.detach(|| {
            envs.par_iter_mut()
                .zip(obs.par_chunks_mut(OBS_DIM))
                .zip(rew.par_iter_mut())
                .zip(done.par_iter_mut())
                .zip(a.par_chunks(3))
                .for_each(|((((e, o), r), d), act)| {
                    let (reward, fin) = e.step(act);
                    *r = reward;
                    *d = fin;
                    if fin {
                        e.reset();
                    }
                    e.observe(o);
                });
        });

        Ok((
            self.obs_array(py),
            PyArray1::from_slice(py, &self.rew),
            PyArray1::from_slice(py, &self.done),
        ))
    }
}

impl VecEnv {
    fn obs_array<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray2<f32>> {
        let a = PyArray2::<f32>::zeros(py, [self.envs.len(), OBS_DIM], false);
        unsafe { a.as_slice_mut().unwrap().copy_from_slice(&self.obs) };
        a
    }
}

#[pymodule]
fn engine(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<VecEnv>()?;
    m.add("OBS_DIM", OBS_DIM)?;
    m.add("EPISODE_TICKS", EPISODE_TICKS)?;
    m.add("N_TOOLS", N_TOOLS)?;
    m.add("IDX_LOOMING", OBS_DIM - 1)?;
    m.add("IDX_LOS", N_RAYS)?;
    Ok(())
}
