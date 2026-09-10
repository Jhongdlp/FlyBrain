//! Lo que se le viene encima al boss, como un número.
//!
//! Es la entrada sensorial de la mosca, y vive acá y no en Python por la misma
//! razón que [`crate::raycast`]: **es geometría, no política.** No hay nada que
//! aprender en calcular si un objeto se acerca; lo que sí hay que decidir es qué
//! hacer al respecto, y eso es del cerebro.
//!
//! Que viva en el motor además la hace determinista y parte del replay: una
//! pelea grabada contra la mosca se re-simula con la misma percepción exacta.

use crate::types::*;

/// Tasa de expansión angular de lo que se acerca, en radianes por segundo.
///
/// Para un objeto de radio `r` a distancia `d` que se acerca a velocidad radial
/// `v`, el tamaño angular es `θ ≈ 2r/d` y su derivada `dθ/dt = 2rv/d²`. Ésa es
/// **la** señal de looming, y es lo que responden LC4 y LPLC2 en la mosca: no la
/// distancia ni la velocidad por separado, sino cuánto crece la cosa en el
/// campo visual.
///
/// La cuadrática en `d` es lo que hace que la señal sea casi nula durante casi
/// todo el vuelo y se dispare al final. Por eso un umbral sobre esto es un
/// detector de "ya", no de "hay algo por ahí".
pub fn looming(w: &World) -> f32 {
    // El jugador que carga también se expande en el campo visual, y en la mosca
    // es el mismo circuito: LC4 no distingue un depredador de una mano. Por eso
    // va sumado y no aparte — separarlos sería darle a la mosca una información
    // que su anatomía no tiene.
    de_proyectiles(w) + expansion(w.player.pos, w.player.vel, w.player.radius, &w.boss)
}

/// Solo lo que dispararon. **No es lo que ve la mosca**: existe para poder medir
/// si esquivó *un tiro*, que es la pregunta del experimento. Mezclado con el
/// jugador acercándose, cualquier umbral de "hay amenaza" se llena de ticks en
/// los que no hay nada que esquivar.
pub fn de_proyectiles(w: &World) -> f32 {
    w.projectiles
        .iter()
        .filter(|p| p.owner == Side::Player)
        .map(|p| expansion(p.pos, p.vel, p.radius, &w.boss))
        .sum()
}

fn expansion(pos: Vec2, vel: Vec2, radio: f32, boss: &Actor) -> f32 {
    let rel = pos.sub(boss.pos);
    let d = rel.len();
    // Ya está encima: la fórmula diverge y el dato no sirve. La colisión ya
    // pasó, esquivar no es la pregunta.
    if d <= radio + boss.radius {
        return 0.0;
    }
    let cierre = -vel.sub(boss.vel).dot(rel.scale(1.0 / d));
    if cierre <= 0.0 {
        return 0.0; // se aleja
    }
    2.0 * radio * cierre / (d * d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{arena, weapons};

    fn mundo() -> World {
        World::new(arena::launch(), 1)
    }

    #[test]
    fn lo_que_se_aleja_no_asusta() {
        let mut w = mundo();
        w.boss.pos = Vec2::new(10.0, 10.0);
        w.player.pos = Vec2::new(16.0, 10.0);
        w.player.vel = Vec2::new(5.0, 0.0); // huyendo
        assert_eq!(looming(&w), 0.0);
    }

    #[test]
    fn se_dispara_al_final_y_no_antes() {
        let mut w = mundo();
        w.boss.pos = Vec2::new(10.0, 10.0);
        let a_distancia = |d: f32| {
            let mut w = w.clone();
            w.player.pos = Vec2::new(10.0 + d, 10.0);
            w.player.vel = Vec2::new(-5.0, 0.0);
            looming(&w)
        };
        let (lejos, cerca) = (a_distancia(10.0), a_distancia(2.5));
        // Cuadrática: cuatro veces más cerca son dieciséis veces más señal.
        assert!(cerca > lejos * 10.0, "lejos {lejos} cerca {cerca}");
    }

    /// El caso que importa: el cañón del jugador es lo que el boss tiene que
    /// aprender a esquivar, y su vuelo dura 18 ticks contra los 16 que necesita
    /// para apartarse. La señal tiene que existir **antes** de ese margen.
    #[test]
    fn el_disparo_del_jugador_se_ve_venir() {
        let mut w = mundo();
        w.boss.pos = Vec2::new(16.0, 10.0);
        w.player.pos = Vec2::new(8.0, 10.0);
        w.player.facing = 0.0;
        let mut ev = StepEvents::default();
        weapons::resolve_player(&mut w, PlayerAction::Ability, 0.0, &mut ev);
        assert_eq!(w.projectiles.len(), 1, "el cañón no disparó");

        let mut visto = None;
        for t in 0..40 {
            if looming(&w) > 0.05 {
                visto = Some(t);
                break;
            }
            crate::step(&mut w, PlayerInput::default(), BossAction::Idle);
        }
        let t = visto.expect("el proyectil nunca produjo señal de looming");
        assert!(t < 18, "se vio recién en el tick {t}, cuando ya impactó");
    }
}
