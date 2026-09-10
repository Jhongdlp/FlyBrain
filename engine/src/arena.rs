//! T3 — La arena es dato, no código. Se parsea una vez al inicio, nunca en el
//! path caliente.
//!
//! Formato: `[cx, cy, hx, hy]` para los estáticos y `[cx, cy, hx, hy, masa]`
//! para los empujables. Centro y semiejes en vez de min/max porque es lo que un
//! editor visual escribe y lo que una persona lee sin restar.
//!
//! El parser es un subconjunto de JSON de ~50 líneas en vez de `serde_json`:
//! el esquema es fijo, las arenas son assets del repo (no llegan del cliente) y
//! el bundle wasm tiene un presupuesto de 200KB. Si algún día hay arenas
//! generadas por usuarios, ese es el momento de traer un parser de verdad —
//! ahí sí pasa a ser frontera de confianza.

use crate::types::{Aabb, Arena, DynBody, Vec2};

/// Motivo del fallo. Los archivos de arena son assets del repo: esto sirve para
/// depurar, no para defenderse.
#[derive(Debug, PartialEq, Eq)]
pub struct ArenaError(pub &'static str);

/// La única arena del lanzamiento. `include_str!` es compile-time: el motor
/// sigue sin tocar el disco.
pub fn launch() -> Arena {
    parse(include_str!("../../arenas/launch.json")).expect("arenas/launch.json inválida")
}

/// Registro de arenas. El id viaja en el log de pelea y el servidor resuelve la
/// geometría por su cuenta — el cliente no la manda.
pub fn by_id(id: u16) -> Option<Arena> {
    match id {
        0 => Some(launch()),
        _ => None,
    }
}

pub fn parse(src: &str) -> Result<Arena, ArenaError> {
    let one = |k| -> Result<f32, ArenaError> {
        let v = nums(field(src, k)?)?;
        match v[..] {
            [x] => Ok(x),
            _ => Err(ArenaError("se esperaba un solo número")),
        }
    };
    let pair = |k| -> Result<Vec2, ArenaError> {
        let v = nums(field(src, k)?)?;
        match v[..] {
            [x, y] => Ok(Vec2::new(x, y)),
            _ => Err(ArenaError("se esperaba un par [x, y]")),
        }
    };

    let statics = nums(field(src, "statics")?)?
        .chunks(4)
        .map(|c| match c {
            [x, y, hx, hy] => Ok(Aabb::from_center(Vec2::new(*x, *y), Vec2::new(*hx, *hy))),
            _ => Err(ArenaError("estático incompleto: [cx, cy, hx, hy]")),
        })
        .collect::<Result<Vec<_>, _>>()?;

    let dynamics = nums(field(src, "dynamics")?)?
        .chunks(5)
        .map(|c| match c {
            [x, y, hx, hy, m] if *m > 0.0 => Ok(DynBody {
                pos: Vec2::new(*x, *y),
                vel: Vec2::ZERO,
                half: Vec2::new(*hx, *hy),
                mass: *m,
                hp: i32::MAX,
            }),
            _ => Err(ArenaError("empujable incompleto: [cx, cy, hx, hy, masa>0]")),
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Arena {
        id: one("id")? as u16,
        seed: one("seed")? as u64,
        size: pair("size")?,
        spawn_player: pair("spawn_player")?,
        spawn_boss: pair("spawn_boss")?,
        statics,
        dynamics,
    })
}

/// El valor de `"clave"`: hasta el corchete que cierra si es un array, hasta la
/// coma si es un número.
fn field<'a>(src: &'a str, key: &str) -> Result<&'a str, ArenaError> {
    let mut it = src.match_indices('"').filter_map(|(i, _)| {
        let rest = &src[i + 1..];
        rest.strip_prefix(key)?.strip_prefix('"')
    });
    let v = it.next().ok_or(ArenaError("falta una clave"))?;
    let v = v
        .trim_start()
        .strip_prefix(':')
        .ok_or(ArenaError("clave sin ':'"))?;

    let mut depth = 0i32;
    for (i, c) in v.bytes().enumerate() {
        match c {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(&v[..=i]);
                }
            }
            b',' | b'}' if depth == 0 => return Ok(&v[..i]),
            _ => {}
        }
    }
    Err(ArenaError("valor sin cerrar"))
}

/// Todos los números de un fragmento, en orden. La anidación de los arrays se
/// ignora a propósito: el agrupado lo hace `chunks`.
fn nums(s: &str) -> Result<Vec<f32>, ArenaError> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() && b[i] != b'-' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < b.len() && matches!(b[i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-') {
            i += 1;
        }
        out.push(
            s[start..i]
                .parse()
                .map_err(|_| ArenaError("número inválido"))?,
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collision::closest_on_aabb;
    use crate::raycast::line_of_sight;
    use crate::types::{BOSS_RADIUS, World};

    #[test]
    fn launch_tiene_la_geometria_esperada() {
        let a = launch();
        assert_eq!(a.id, 0);
        assert_eq!(a.seed, 1);
        assert_eq!(a.size, Vec2::new(32.0, 20.0));
        assert_eq!(a.spawn_player, Vec2::new(4.0, 10.0));
        assert_eq!(a.spawn_boss, Vec2::new(28.0, 10.0));
        assert_eq!(a.statics.len(), 12);
        assert_eq!(a.dynamics.len(), 2);
        // Muro central sur: junto con el norte parte la arena en dos y deja
        // solo dos rutas — la puerta (y 12-15) y el pasillo sur (y 0-4).
        assert_eq!(a.statics[0].min, Vec2::new(15.25, 4.0));
        assert_eq!(a.statics[0].max, Vec2::new(16.75, 12.0));
        assert_eq!(a.dynamics[0].mass, 3.0);
    }

    /// **Los dos bolsillos son la razón de ser de esta arena.** Un rincón sin
    /// salida es lo que le da sentido al empujón de
    /// [`crate::minions::salida`]: sin geometría cerrada, "cortar la ruta de
    /// escape" no significa nada porque siempre hay otra.
    ///
    /// El test mide justo eso y no la lista de rectángulos: desde el fondo de
    /// un bolsillo, la mayoría de los rayos chocan cerca; desde el centro de la
    /// arena, casi ninguno.
    #[test]
    fn los_bolsillos_encierran_de_verdad() {
        use crate::raycast::{rays_from, N_RAYS};
        let w = World::new(launch(), 0);
        let tapados = |p: Vec2| rays_from(p, 0.0, &w).iter().filter(|&&d| d < 5.0).count();
        // Fondo del bolsillo noroeste y del sureste.
        assert!(tapados(Vec2::new(9.5, 18.5)) >= N_RAYS * 3 / 4);
        assert!(tapados(Vec2::new(22.5, 1.5)) >= N_RAYS * 3 / 4);
        // Campo abierto del lado oeste: sitio para correr.
        assert!(tapados(Vec2::new(5.0, 10.0)) <= N_RAYS / 2);
    }

    /// **Cada grupo de muros tiene un trabajo, y acá se comprueba que lo
    /// hace.** Es lo que separa la geometría del decorado: un rectángulo que no
    /// cambia ninguna decisión del boss es coste de datos sin contrapartida —
    /// reparte los contadores entre contextos que dan lo mismo.
    ///
    /// Los trabajos, y por qué cada uno existe:
    ///
    /// - **Espina central** — corta la línea de spawn (test aparte).
    /// - **Bolsillos** — encierran, para que cortar la salida signifique algo
    ///   (test aparte).
    /// - **Cobertura media** — rompe la visión *a distancia de onda y
    ///   embestida*, que es donde el boss elige entre sus herramientas. Sin
    ///   esto la elección es siempre la misma y el bandit no tiene nada que
    ///   aprender de la geometría.
    /// - **Carriles largos** — dejan líneas de tiro de más de quince unidades,
    ///   que es lo único que le da sentido al cañón.
    #[test]
    fn cada_muro_hace_su_trabajo() {
        use crate::weapons::{CHARGE_REACH, WAVE_MAX_R};
        let w = World::new(launch(), 0);
        let libre = |a: Vec2, b: Vec2| line_of_sight(a, b, &w).0;

        // 1. Cobertura a distancia de onda/embestida: tiene que existir un par
        //    de posiciones separadas por ese rango con la visión cortada.
        let mut cortadas = 0;
        let mut paso = 0.0;
        while paso < w.arena.size.x {
            let mut y = 0.0;
            while y < w.arena.size.y {
                let a = Vec2::new(paso, y);
                for d in [CHARGE_REACH, WAVE_MAX_R] {
                    for dir in [Vec2::new(d, 0.0), Vec2::new(0.0, d)] {
                        let b = a.add(dir);
                        if b.x < w.arena.size.x && b.y < w.arena.size.y && !libre(a, b) {
                            cortadas += 1;
                        }
                    }
                }
                y += 1.0;
            }
            paso += 1.0;
        }
        assert!(
            cortadas > 100,
            "casi no hay cobertura al alcance de la onda y la embestida: {cortadas} pares cortados"
        );

        // 2. Carriles largos: alguna línea libre de más de quince unidades, o el
        //    cañón no tiene para qué existir.
        let largo = (0..w.arena.size.y as i32).any(|y| {
            let y = y as f32 + 0.5;
            libre(Vec2::new(1.0, y), Vec2::new(17.0, y))
                || libre(Vec2::new(15.0, y), Vec2::new(31.0, y))
        });
        assert!(largo, "no queda ninguna línea de tiro larga: el cañón sobra");
    }

    #[test]
    fn ningun_estatico_se_superpone_con_otro() {
        let a = launch();
        for (i, x) in a.statics.iter().enumerate() {
            for y in &a.statics[i + 1..] {
                assert!(!x.overlaps(y), "{x:?} pisa {y:?}");
            }
            assert!(
                x.min.x >= 0.0 && x.min.y >= 0.0 && x.max.x <= a.size.x && x.max.y <= a.size.y,
                "{x:?} se sale de la arena"
            );
        }
    }

    #[test]
    fn los_spawns_estan_libres() {
        let a = launch();
        for p in [a.spawn_player, a.spawn_boss] {
            for s in &a.statics {
                assert!(p.dist(closest_on_aabb(p, s)) > BOSS_RADIUS, "{p:?} en {s:?}");
            }
        }
    }

    /// La cobertura tiene que servir de algo: el bloque central corta la línea
    /// entre los dos spawns, así que la pelea no arranca con tiro libre.
    #[test]
    fn el_bloque_central_corta_la_linea_de_spawn() {
        let w = World::new(launch(), 0);
        let (visible, _) = line_of_sight(w.arena.spawn_player, w.arena.spawn_boss, &w);
        assert!(!visible);
    }

    /// BFS sobre una grilla inflada por el radio del boss: si el boss puede ir
    /// de un spawn al otro, el jugador (más chico) también.
    #[test]
    fn hay_camino_navegable_entre_los_spawns() {
        let a = launch();
        const CELL: f32 = 0.25;
        let (nx, ny) = ((a.size.x / CELL) as usize, (a.size.y / CELL) as usize);
        let cell_center = |i: usize, j: usize| {
            Vec2::new(
                (i as f32 + 0.5) * CELL,
                (j as f32 + 0.5) * CELL,
            )
        };
        let libre = |p: Vec2| {
            p.x >= BOSS_RADIUS
                && p.y >= BOSS_RADIUS
                && p.x <= a.size.x - BOSS_RADIUS
                && p.y <= a.size.y - BOSS_RADIUS
                && a
                    .statics
                    .iter()
                    .all(|s| p.dist_sq(closest_on_aabb(p, s)) >= BOSS_RADIUS * BOSS_RADIUS)
        };
        let idx = |p: Vec2| ((p.x / CELL) as usize, (p.y / CELL) as usize);

        let mut seen = vec![false; nx * ny];
        let (sx, sy) = idx(a.spawn_player);
        let (gx, gy) = idx(a.spawn_boss);
        assert!(libre(cell_center(sx, sy)) && libre(cell_center(gx, gy)));

        let mut q = std::collections::VecDeque::from([(sx, sy)]);
        seen[sy * nx + sx] = true;
        while let Some((i, j)) = q.pop_front() {
            if (i, j) == (gx, gy) {
                return;
            }
            for (di, dj) in [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)] {
                let (ni, nj) = (i as i32 + di, j as i32 + dj);
                if ni < 0 || nj < 0 || ni as usize >= nx || nj as usize >= ny {
                    continue;
                }
                let (ni, nj) = (ni as usize, nj as usize);
                if !seen[nj * nx + ni] && libre(cell_center(ni, nj)) {
                    seen[nj * nx + ni] = true;
                    q.push_back((ni, nj));
                }
            }
        }
        panic!("no hay camino navegable entre los spawns");
    }

    #[test]
    fn rechaza_arena_malformada() {
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"id":0,"seed":1,"size":[32],"spawn_player":[1,1],
                          "spawn_boss":[2,2],"statics":[],"dynamics":[]}"#)
            .is_err());
        // Estático con 3 números en vez de 4.
        assert!(parse(r#"{"id":0,"seed":1,"size":[32,20],"spawn_player":[1,1],
                          "spawn_boss":[2,2],"statics":[[1,2,3]],"dynamics":[]}"#)
            .is_err());
        // Masa cero: una caja inmóvil es un estático mal declarado.
        assert!(parse(r#"{"id":0,"seed":1,"size":[32,20],"spawn_player":[1,1],
                          "spawn_boss":[2,2],"statics":[],"dynamics":[[1,2,3,4,0]]}"#)
            .is_err());
    }

    #[test]
    fn arena_vacia_es_valida() {
        let a = parse(r#"{"id":7,"seed":9,"size":[10,10],"spawn_player":[1,1],
                          "spawn_boss":[9,9],"statics":[],"dynamics":[]}"#)
            .unwrap();
        assert_eq!(a.id, 7);
        assert!(a.statics.is_empty() && a.dynamics.is_empty());
    }

    #[test]
    fn by_id_solo_conoce_la_del_lanzamiento() {
        assert!(by_id(0).is_some());
        assert!(by_id(1).is_none());
    }
}
