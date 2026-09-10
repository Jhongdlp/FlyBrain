//! T2 — Raycast (algoritmo slab), percepción por rayos y línea de visión.
//!
//! Los rayos se calculan acá contra los rectángulos de colisión 2D, **nunca**
//! con el `Raycaster` de Three.js: ese consulta meshes de la escena y ataría la
//! percepción del boss al render, perdiendo headless, replay y entrenamiento de
//! una sola vez.

use crate::types::{Aabb, Vec2, World};

/// Cantidad de rayos de percepción del boss.
pub const N_RAYS: usize = 16;

/// Alcance de la percepción, en unidades de mundo. Más allá de esto el boss no
/// distingue "pared lejos" de "nada": es una perilla de calibración, no una
/// constante física.
pub const RAY_RANGE: f32 = 20.0;

/// Intervalo `[t_entrada, t_salida]` del rayo dentro de una franja del AABB.
///
/// El caso `d == 0` se trata aparte a propósito. La versión clásica con
/// `1.0 / 0.0` produce `0.0 * inf = NaN` cuando el origen cae justo sobre la
/// cara, y ahí el resultado depende de cómo cada plataforma trate el NaN en
/// `min`/`max`. En este repo eso no es un caso raro: es el verificador de
/// replays dando falsos positivos.
fn slab(o: f32, d: f32, lo: f32, hi: f32) -> (f32, f32) {
    if d == 0.0 {
        if o < lo || o > hi {
            (f32::INFINITY, f32::NEG_INFINITY) // intervalo vacío
        } else {
            (f32::NEG_INFINITY, f32::INFINITY)
        }
    } else {
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        if t1 <= t2 {
            (t1, t2)
        } else {
            (t2, t1)
        }
    }
}

/// Distancia del origen al AABB a lo largo de `dir` (normalizado), o `None`.
/// Un rayo que arranca dentro devuelve `Some(0.0)`.
pub fn ray_aabb(o: Vec2, dir: Vec2, max: f32, b: &Aabb) -> Option<f32> {
    let (xlo, xhi) = slab(o.x, dir.x, b.min.x, b.max.x);
    let (ylo, yhi) = slab(o.y, dir.y, b.min.y, b.max.y);
    let tmin = xlo.max(ylo);
    let tmax = xhi.min(yhi);
    if tmax < 0.0 || tmin > tmax || tmin > max {
        return None;
    }
    Some(tmin.max(0.0))
}

/// El impacto más cercano contra la escena: estáticos y cajas empujables.
/// Los actores no bloquean rayos.
pub fn raycast(o: Vec2, dir: Vec2, max: f32, w: &World) -> Option<f32> {
    let mut best: Option<f32> = None;
    for b in &w.arena.statics {
        if let Some(t) = ray_aabb(o, dir, max, b) {
            best = Some(best.map_or(t, |x: f32| x.min(t)));
        }
    }
    for d in &w.dynamics {
        if let Some(t) = ray_aabb(o, dir, max, &d.aabb()) {
            best = Some(best.map_or(t, |x: f32| x.min(t)));
        }
    }
    best
}

/// Distancia a la pared de la arena a lo largo de `dir`. Divisiones y
/// comparaciones: nada que pueda diferir entre wasm y nativo.
fn to_border(o: Vec2, dir: Vec2, size: Vec2) -> f32 {
    let eje = |o: f32, d: f32, hi: f32| {
        if d > 0.0 {
            (hi - o) / d
        } else if d < 0.0 {
            -o / d
        } else {
            f32::INFINITY
        }
    };
    eje(o.x, dir.x, size.x).min(eje(o.y, dir.y, size.y)).max(0.0)
}

/// 16 rayos equiespaciados desde `o`, en unidades de mundo, topados en
/// [`RAY_RANGE`]. Los ángulos arrancan en `base`.
///
/// **Cuenta la pared de la arena**, no solo los obstáculos: estar contra el
/// borde es estar acorralado igual que estarlo contra un pilar, y sin esto los
/// dos casos se leen idénticos a campo abierto.
pub fn rays_from(o: Vec2, base: f32, w: &World) -> [f32; N_RAYS] {
    let step = core::f32::consts::TAU / N_RAYS as f32;
    core::array::from_fn(|i| {
        let dir = Vec2::from_angle(base + i as f32 * step);
        let max = to_border(o, dir, w.arena.size).min(RAY_RANGE);
        raycast(o, dir, max, w).unwrap_or(max)
    })
}

/// Hacia dónde tiene sitio para correr quien está en `o`, y **cuánto**: el
/// promedio de las direcciones de [`rays_from`] pesado por lo que cada una
/// tiene de libre. El módulo va en [0,1].
///
/// A campo abierto los rayos se cancelan y da ~0: no hay ruta de escape que
/// cortar porque son todas. En un bolsillo apunta a la boca y crece. Ésa es la
/// propiedad que importa — el empujón de [`crate::minions::deploy`] aparece
/// solo donde hay geometría que aprovechar, y se apaga solo donde no la hay,
/// sin umbral ni bandera.
///
/// Es geometría, no política: no hay nada que aprender en calcular por dónde se
/// sale de un rincón. Lo que sí hay que aprender es **cuándo** conviene
/// cortarlo, y eso sigue siendo del bandit.
pub fn salida(o: Vec2, w: &World) -> Vec2 {
    let d = rays_from(o, 0.0, w);
    let total: f32 = d.iter().sum();
    if total <= 1e-6 {
        return Vec2::ZERO;
    }
    let step = core::f32::consts::TAU / N_RAYS as f32;
    let mut s = Vec2::ZERO;
    for (i, &t) in d.iter().enumerate() {
        s = s.add(Vec2::from_angle(i as f32 * step).scale(t));
    }
    s.scale(1.0 / total)
}

/// 16 rayos desde el boss, distancia normalizada a [0,1]. 1.0 = nada dentro del
/// alcance.
///
/// **Egocéntricos**: los ángulos salen de `facing`, no de los ejes del mundo.
/// Así "hay pared a mi derecha" es siempre la misma entrada y la política
/// generaliza entre mapas en vez de memorizar orientaciones.
pub fn perception(w: &World) -> [f32; N_RAYS] {
    rays_from(w.boss.pos, w.boss.facing, w).map(|t| t / RAY_RANGE)
}

/// `(hay visión libre, distancia)`. Si está bloqueada, la distancia es la del
/// obstáculo que la bloquea; si está libre, la que separa a los dos puntos.
///
/// Dos números. Es toda la señal que hace falta para el juego táctico entero —
/// no hacen falta CNN ni mapa de ocupación.
pub fn line_of_sight(a: Vec2, b: Vec2, w: &World) -> (bool, f32) {
    let d = b.sub(a);
    let dist = d.len();
    if dist <= 1e-6 {
        return (true, 0.0);
    }
    match raycast(a, d.scale(1.0 / dist), dist, w) {
        Some(t) => (false, t),
        None => (true, dist),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Arena, DynBody};

    fn mundo(statics: Vec<Aabb>) -> World {
        World::new(
            Arena {
                id: 0,
                seed: 0,
                size: Vec2::new(40.0, 40.0),
                statics,
                spawn_player: Vec2::new(1.0, 1.0),
                spawn_boss: Vec2::new(20.0, 20.0),
                dynamics: Vec::new(),
            },
            1,
        )
    }

    fn pared(x0: f32, y0: f32, x1: f32, y1: f32) -> Aabb {
        Aabb {
            min: Vec2::new(x0, y0),
            max: Vec2::new(x1, y1),
        }
    }

    const DER: Vec2 = Vec2 { x: 1.0, y: 0.0 };

    #[test]
    fn distancia_exacta_a_la_cara() {
        let w = mundo(vec![pared(10.0, -5.0, 11.0, 5.0)]);
        assert_eq!(ray_aabb(Vec2::ZERO, DER, 100.0, &w.arena.statics[0]), Some(10.0));
    }

    #[test]
    fn rayo_que_apunta_al_lado_contrario_no_pega() {
        let w = mundo(vec![pared(10.0, -5.0, 11.0, 5.0)]);
        let izq = Vec2::new(-1.0, 0.0);
        assert_eq!(ray_aabb(Vec2::ZERO, izq, 100.0, &w.arena.statics[0]), None);
    }

    #[test]
    fn fuera_de_alcance_no_pega() {
        let w = mundo(vec![pared(10.0, -5.0, 11.0, 5.0)]);
        assert_eq!(ray_aabb(Vec2::ZERO, DER, 9.0, &w.arena.statics[0]), None);
    }

    /// El caso que rompe la versión con `1.0 / 0.0`.
    #[test]
    fn paralelo_a_la_cara_no_da_falso_positivo() {
        let b = pared(10.0, 10.0, 20.0, 20.0);
        // Por debajo de la caja.
        assert_eq!(ray_aabb(Vec2::new(0.0, 5.0), DER, 100.0, &b), None);
        // Rozando exactamente la cara inferior: NaN en la versión ingenua.
        assert_eq!(ray_aabb(Vec2::new(0.0, 10.0), DER, 100.0, &b), Some(10.0));
        // Rozando exactamente la cara superior.
        assert_eq!(ray_aabb(Vec2::new(0.0, 20.0), DER, 100.0, &b), Some(10.0));
        // Justo por encima.
        assert_eq!(ray_aabb(Vec2::new(0.0, 20.5), DER, 100.0, &b), None);
    }

    #[test]
    fn rayo_que_arranca_dentro_devuelve_cero() {
        let b = pared(0.0, 0.0, 10.0, 10.0);
        assert_eq!(ray_aabb(Vec2::new(5.0, 5.0), DER, 100.0, &b), Some(0.0));
    }

    #[test]
    fn pared_en_el_medio_bloquea_la_vision() {
        let w = mundo(vec![pared(10.0, 0.0, 12.0, 40.0)]);
        let (visible, d) = line_of_sight(Vec2::new(5.0, 20.0), Vec2::new(20.0, 20.0), &w);
        assert!(!visible);
        assert_eq!(d, 5.0);
    }

    #[test]
    fn sin_pared_la_vision_es_libre() {
        let w = mundo(vec![]);
        let (visible, d) = line_of_sight(Vec2::new(5.0, 20.0), Vec2::new(20.0, 20.0), &w);
        assert!(visible);
        assert_eq!(d, 15.0);
    }

    /// Una pared que no llega a cruzar la línea no debe bloquearla.
    #[test]
    fn pared_fuera_de_la_linea_no_bloquea() {
        let w = mundo(vec![pared(10.0, 25.0, 12.0, 40.0)]);
        let (visible, _) = line_of_sight(Vec2::new(5.0, 20.0), Vec2::new(20.0, 20.0), &w);
        assert!(visible);
    }

    #[test]
    fn la_caja_empujable_tambien_bloquea() {
        let mut w = mundo(vec![]);
        w.dynamics.push(DynBody {
            pos: Vec2::new(12.0, 20.0),
            vel: Vec2::ZERO,
            half: Vec2::new(1.0, 1.0),
            mass: 1.0,
            hp: i32::MAX,
        });
        let (visible, d) = line_of_sight(Vec2::new(5.0, 20.0), Vec2::new(20.0, 20.0), &w);
        assert!(!visible);
        assert_eq!(d, 6.0);
    }

    /// Sin obstáculos el boss sigue viendo las paredes de la arena: en (20,20)
    /// de una arena 40x40 el borde está a 20, que es justo el alcance.
    #[test]
    fn percepcion_en_arena_vacia_llega_al_borde() {
        let w = mundo(vec![]);
        let p = perception(&w);
        assert_eq!(p[0], 1.0);
        assert!(p.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    /// El borde de la arena acorrala igual que un pilar: pegado a la pared
    /// oeste, la salida apunta al este.
    #[test]
    fn la_salida_apunta_al_campo_abierto() {
        let w = mundo(vec![]);
        let s = salida(Vec2::new(1.0, 20.0), &w);
        assert!(s.x > 0.2, "{s:?}");
        assert!(s.y.abs() < 0.05, "{s:?}");
    }

    /// La propiedad que hace que el empujón no haga falta apagarlo a mano.
    #[test]
    fn en_el_centro_no_hay_salida_privilegiada() {
        let w = mundo(vec![]);
        assert!(salida(Vec2::new(20.0, 20.0), &w).len() < 0.05);
    }

    /// Un bolsillo en U: la salida apunta a la boca, y con más fuerza que
    /// contra una pared suelta.
    #[test]
    fn la_salida_sale_del_bolsillo() {
        let w = mundo(vec![
            pared(10.0, 10.0, 11.0, 30.0),
            pared(20.0, 10.0, 21.0, 30.0),
            pared(10.0, 29.0, 21.0, 30.0),
        ]);
        let dentro = salida(Vec2::new(15.5, 27.0), &w);
        assert!(dentro.y < -0.2, "{dentro:?}");
        assert!(dentro.len() > salida(Vec2::new(1.0, 20.0), &w).len());
    }

    #[test]
    fn percepcion_ve_la_pared_y_normaliza() {
        // Boss en (20,20) mirando a +x; pared cuya cara está en x=25.
        let mut w = mundo(vec![pared(25.0, 0.0, 30.0, 40.0)]);
        w.boss.facing = 0.0;
        let p = perception(&w);
        assert_eq!(p[0], 5.0 / RAY_RANGE);
        // El rayo opuesto (índice 8, 180°) llega hasta la pared de la arena.
        assert_eq!(p[N_RAYS / 2], 1.0);
        assert!(p.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    /// Egocéntrica: girar al boss rota la lectura, no la cambia.
    #[test]
    fn percepcion_es_egocentrica() {
        let mut w = mundo(vec![pared(25.0, 0.0, 30.0, 40.0)]);
        w.boss.facing = 0.0;
        let a = perception(&w);
        w.boss.facing = core::f32::consts::TAU / N_RAYS as f32; // un slot
        let b = perception(&w);
        assert!((a[1] - b[0]).abs() < 1e-4, "a={:?} b={:?}", a[1], b[0]);
    }
}
