//! T1 — Círculo-círculo, círculo-AABB, empuje de cuerpos dinámicos y
//! confinamiento a los bordes. Sin librería de física.
//!
//! Resolución **posicional**, no por impulsos: se corrige la penetración y
//! nada más. Los actores son de masa infinita — nunca los desplaza una caja —
//! y las cajas absorben la corrección entera.
//!
//! `ponytail: sin apilamiento, sin joints, sin rotación, sin transferencia de
//! velocidad. Agregar cuando una mecánica lo pida, no antes.`

use crate::types::{Aabb, Actor, Arena, DynBody, Vec2};

/// Punto del AABB más cercano a `p`. Base de todo lo demás.
///
/// `max().min()` en vez de `clamp()`: `clamp` entra en pánico si el rango está
/// invertido, y un AABB degenerado no debería tumbar la simulación.
pub fn closest_on_aabb(p: Vec2, b: &Aabb) -> Vec2 {
    Vec2::new(
        p.x.max(b.min.x).min(b.max.x),
        p.y.max(b.min.y).min(b.max.y),
    )
}

/// Separa dos actores superpuestos dejándolos tangentes. Masa infinita para los
/// dos: la penetración se reparte por mitades.
pub fn resolve_actors(a: &mut Actor, b: &mut Actor) {
    let d = b.pos.sub(a.pos);
    let r = a.radius + b.radius;
    let d2 = d.len_sq();
    if d2 >= r * r {
        return;
    }
    // Centros exactamente coincidentes: separar por +x. Arbitrario pero
    // determinista, que es lo único que importa acá.
    let n = if d2 > 0.0 {
        d.scale(1.0 / d2.sqrt())
    } else {
        Vec2::new(1.0, 0.0)
    };
    let half = (r - d2.sqrt()) * 0.5;
    a.pos = a.pos.sub(n.scale(half));
    b.pos = b.pos.add(n.scale(half));
}

/// Saca al actor de un AABB. Devuelve `true` si hubo contacto.
pub fn resolve_actor_aabb(a: &mut Actor, b: &Aabb) -> bool {
    let c = closest_on_aabb(a.pos, b);
    let d = a.pos.sub(c);
    let d2 = d.len_sq();

    if d2 > 0.0 {
        if d2 >= a.radius * a.radius {
            return false;
        }
        // Fuera del AABB pero superpuesto: empujar por la normal hasta tangencia.
        a.pos = c.add(d.scale(a.radius / d2.sqrt()));
        return true;
    }

    // Centro dentro del AABB: salir por la cara más cercana. Desempate por el
    // orden de comparación — determinista.
    let (l, r) = (a.pos.x - b.min.x, b.max.x - a.pos.x);
    let (u, dn) = (a.pos.y - b.min.y, b.max.y - a.pos.y);
    let m = l.min(r).min(u).min(dn);
    if m == l {
        a.pos.x = b.min.x - a.radius;
    } else if m == r {
        a.pos.x = b.max.x + a.radius;
    } else if m == u {
        a.pos.y = b.min.y - a.radius;
    } else {
        a.pos.y = b.max.y + a.radius;
    }
    true
}

/// Estáticos primero, bordes al final: así el actor nunca termina fuera de la
/// arena por culpa de un empuje.
pub fn resolve_actor_arena(a: &mut Actor, arena: &Arena) {
    for s in &arena.statics {
        resolve_actor_aabb(a, s);
    }
    confine(&mut a.pos, a.radius, arena);
}

/// Confina un punto con radio a la arena `(0,0)..(size)`.
pub fn confine(pos: &mut Vec2, radius: f32, arena: &Arena) {
    pos.x = pos.x.max(radius).min(arena.size.x - radius);
    pos.y = pos.y.max(radius).min(arena.size.y - radius);
}

/// Actor contra caja empujable: el actor no se mueve (masa infinita), la caja
/// absorbe la penetración entera.
///
/// La masa no divide esta corrección — sí divide la de caja contra caja. Que un
/// jugador mueva igual de fácil una caja pesada que una liviana es la simpleza
/// que se paga acá.
/// `ponytail: masa como tope de velocidad de empuje si el peso tiene que
/// sentirse.`
pub fn resolve_actor_dyn(a: &mut Actor, b: &mut DynBody) {
    let bb = b.aabb();
    let c = closest_on_aabb(a.pos, &bb);
    let d = a.pos.sub(c);
    let d2 = d.len_sq();

    if d2 > 0.0 {
        if d2 >= a.radius * a.radius {
            return;
        }
        let dist = d2.sqrt();
        // La caja se aleja: el actor se queda donde está.
        b.pos = b.pos.sub(d.scale((a.radius - dist) / dist));
    } else {
        // Actor dentro de la caja: sacar la caja por el eje de menor solape.
        b.pos = b.pos.add(push_out(a.pos, &bb, a.radius));
    }
}

/// Vector mínimo que saca a la caja de debajo de un punto con radio.
fn push_out(p: Vec2, b: &Aabb, radius: f32) -> Vec2 {
    let (l, r) = (p.x - b.min.x + radius, b.max.x - p.x + radius);
    let (u, dn) = (p.y - b.min.y + radius, b.max.y - p.y + radius);
    let m = l.min(r).min(u).min(dn);
    if m == l {
        Vec2::new(m, 0.0)
    } else if m == r {
        Vec2::new(-m, 0.0)
    } else if m == u {
        Vec2::new(0.0, m)
    } else {
        Vec2::new(0.0, -m)
    }
}

/// Una caja empujada no atraviesa paredes ni se va de la arena. El estático
/// gana siempre: la caja absorbe toda la corrección.
pub fn resolve_dyn_arena(b: &mut DynBody, arena: &Arena) {
    for s in &arena.statics {
        let mtv = mtv_aabb(&b.aabb(), s);
        b.pos = b.pos.add(mtv);
    }
    b.pos.x = b.pos.x.max(b.half.x).min(arena.size.x - b.half.x);
    b.pos.y = b.pos.y.max(b.half.y).min(arena.size.y - b.half.y);
}

/// Traslación mínima que separa `a` de `b`. Nulo si no se tocan.
fn mtv_aabb(a: &Aabb, b: &Aabb) -> Vec2 {
    let ox = a.max.x.min(b.max.x) - a.min.x.max(b.min.x);
    let oy = a.max.y.min(b.max.y) - a.min.y.max(b.min.y);
    if ox <= 0.0 || oy <= 0.0 {
        return Vec2::ZERO;
    }
    if ox <= oy {
        if a.center().x < b.center().x {
            Vec2::new(-ox, 0.0)
        } else {
            Vec2::new(ox, 0.0)
        }
    } else if a.center().y < b.center().y {
        Vec2::new(0.0, -oy)
    } else {
        Vec2::new(0.0, oy)
    }
}

// `ponytail: sin caja-contra-caja. Con una sola caja por arena no hace falta;
// son 4 líneas sobre mtv_aabb repartidas por masa inversa cuando haga falta.`

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Actor;

    fn arena(w: f32, h: f32, statics: Vec<Aabb>) -> Arena {
        Arena {
            id: 0,
            seed: 0,
            size: Vec2::new(w, h),
            statics,
            spawn_player: Vec2::ZERO,
            spawn_boss: Vec2::ZERO,
            dynamics: Vec::new(),
        }
    }

    fn caja(c: Vec2, half: Vec2) -> Aabb {
        Aabb::from_center(c, half)
    }

    #[test]
    fn dos_circulos_quedan_tangentes() {
        let mut a = Actor::new(Vec2::new(0.0, 0.0), 1.0, 10);
        let mut b = Actor::new(Vec2::new(1.0, 0.0), 1.0, 10);
        resolve_actors(&mut a, &mut b);
        assert_eq!(a.pos, Vec2::new(-0.5, 0.0));
        assert_eq!(b.pos, Vec2::new(1.5, 0.0));
        assert_eq!(a.pos.dist(b.pos), 2.0);
    }

    #[test]
    fn circulos_separados_no_se_tocan() {
        let mut a = Actor::new(Vec2::new(0.0, 0.0), 1.0, 10);
        let mut b = Actor::new(Vec2::new(5.0, 0.0), 1.0, 10);
        resolve_actors(&mut a, &mut b);
        assert_eq!(a.pos, Vec2::new(0.0, 0.0));
        assert_eq!(b.pos, Vec2::new(5.0, 0.0));
    }

    #[test]
    fn centros_coincidentes_no_dan_nan() {
        let mut a = Actor::new(Vec2::new(3.0, 3.0), 1.0, 10);
        let mut b = Actor::new(Vec2::new(3.0, 3.0), 1.0, 10);
        resolve_actors(&mut a, &mut b);
        assert_eq!(a.pos, Vec2::new(2.0, 3.0));
        assert_eq!(b.pos, Vec2::new(4.0, 3.0));
    }

    /// Terna 3-4-5: la salida es exacta en binario, sin epsilon.
    #[test]
    fn esquina_de_aabb_empuja_por_la_diagonal() {
        let b = Aabb {
            min: Vec2::new(0.0, 0.0),
            max: Vec2::new(10.0, 10.0),
        };
        let mut a = Actor::new(Vec2::new(13.0, 14.0), 10.0, 10);
        assert!(resolve_actor_aabb(&mut a, &b));
        assert_eq!(a.pos, Vec2::new(16.0, 18.0));
        assert_eq!(a.pos.dist(Vec2::new(10.0, 10.0)), 10.0);
    }

    #[test]
    fn ningun_angulo_atraviesa_la_esquina() {
        let b = Aabb {
            min: Vec2::new(0.0, 0.0),
            max: Vec2::new(10.0, 10.0),
        };
        // Barrido alrededor de la esquina (10,10) empujando hacia adentro.
        for i in 0..64 {
            let ang = i as f32 * 0.1;
            let mut a = Actor::new(
                Vec2::new(10.0, 10.0).add(Vec2::from_angle(ang).scale(0.2)),
                0.5,
                10,
            );
            resolve_actor_aabb(&mut a, &b);
            let d = a.pos.dist(closest_on_aabb(a.pos, &b));
            assert!(d >= 0.5 - 1e-5, "i={i} d={d} pos={:?}", a.pos);
        }
    }

    #[test]
    fn centro_dentro_sale_por_la_cara_mas_cercana() {
        let b = Aabb {
            min: Vec2::new(0.0, 0.0),
            max: Vec2::new(10.0, 10.0),
        };
        let mut a = Actor::new(Vec2::new(9.0, 5.0), 1.0, 10);
        assert!(resolve_actor_aabb(&mut a, &b));
        assert_eq!(a.pos, Vec2::new(11.0, 5.0));
    }

    #[test]
    fn tangente_exacta_no_es_penetracion() {
        let b = Aabb {
            min: Vec2::new(0.0, 0.0),
            max: Vec2::new(10.0, 10.0),
        };
        // Exactamente tangente: no es penetración.
        let mut a = Actor::new(Vec2::new(11.0, 5.0), 1.0, 10);
        assert!(!resolve_actor_aabb(&mut a, &b));
        assert_eq!(a.pos, Vec2::new(11.0, 5.0));
    }

    #[test]
    fn actor_confinado_a_la_arena() {
        let ar = arena(20.0, 20.0, vec![]);
        let mut a = Actor::new(Vec2::new(-5.0, 25.0), 1.0, 10);
        resolve_actor_arena(&mut a, &ar);
        assert_eq!(a.pos, Vec2::new(1.0, 19.0));
    }

    #[test]
    fn caja_se_mueve_la_penetracion_exacta_y_el_actor_no() {
        // Actor r=1 en (3.5,5); caja 2x2 centrada en (5,5) -> cara en x=4.
        // Penetración = 1 - 0.5 = 0.5, la absorbe la caja entera.
        let mut a = Actor::new(Vec2::new(3.5, 5.0), 1.0, 10);
        let mut b = DynBody {
            pos: Vec2::new(5.0, 5.0),
            vel: Vec2::ZERO,
            half: Vec2::new(1.0, 1.0),
            mass: 1.0,
            hp: i32::MAX,
        };
        resolve_actor_dyn(&mut a, &mut b);
        assert_eq!(b.pos, Vec2::new(5.5, 5.0));
        assert_eq!(a.pos, Vec2::new(3.5, 5.0), "el actor es de masa infinita");
    }

    #[test]
    fn caja_empujada_no_atraviesa_la_pared() {
        let pared = caja(Vec2::new(10.0, 5.0), Vec2::new(1.0, 5.0)); // x en [9,11]
        let ar = arena(20.0, 20.0, vec![pared]);
        let mut b = DynBody {
            pos: Vec2::new(8.5, 5.0), // x en [7.5, 9.5] -> solapa 0.5
            vel: Vec2::ZERO,
            half: Vec2::new(1.0, 1.0),
            mass: 1.0,
            hp: i32::MAX,
        };
        resolve_dyn_arena(&mut b, &ar);
        assert_eq!(b.pos, Vec2::new(8.0, 5.0));
    }

    #[test]
    fn caja_confinada_a_la_arena() {
        let ar = arena(20.0, 20.0, vec![]);
        let mut b = DynBody {
            pos: Vec2::new(-3.0, 30.0),
            vel: Vec2::ZERO,
            half: Vec2::new(1.0, 1.0),
            mass: 1.0,
            hp: i32::MAX,
        };
        resolve_dyn_arena(&mut b, &ar);
        assert_eq!(b.pos, Vec2::new(1.0, 19.0));
    }
}
