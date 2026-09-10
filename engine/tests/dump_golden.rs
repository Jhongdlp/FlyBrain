// Regenera los fixtures: `cargo test --test dump_golden -- --ignored`
use std::path::Path;

#[test]
#[ignore]
fn dump() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let log = engine::golden::script();
    std::fs::write(dir.join("fight_0.bin"), engine::log::encode(&log)).unwrap();


    let usos = engine::log::expand(&log)
        .iter()
        .filter(|(i, _)| i.action == Some(engine::types::PlayerAction::Ability))
        .count();
    println!("ticks con el cañón del jugador pedido: {usos}");
    {
        let l = engine::golden::script();
        let a = engine::arena::by_id(l.arena_id).unwrap();
        let ini: Vec<_> = a.dynamics.iter().map(|d| d.pos).collect();
        let w = engine::golden::simulate(&l);
        for (i, (d, p0)) in w.dynamics.iter().zip(&ini).enumerate() {
            println!("  caja {i} en {:?} → desplazamiento {:.2}", p0, d.pos.dist(*p0));
        }
    }
    let r = engine::golden::resumen();
    println!("ticks={} telegrafias={} cajas={} boss_hp={} player_hp={}",
             r.ticks, r.telegrafias, r.cajas_movidas, r.boss_hp, r.player_hp);
    for (i, n) in ["martillo", "cañón", "onda", "embestida", "dash"].iter().enumerate() {
        println!("  {n:>10}: golpes={} whiffs={}", r.golpes[i], r.whiffs[i]);
    }
    println!("hash = 0x{:016x}", engine::golden::golden_hash());
}
