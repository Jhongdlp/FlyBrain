//! T7 — El golden test. **Esta es la tarea que justifica todo el diseño**: si
//! el motor no es determinista, no hay replay en servidor, no hay verificador
//! de trampas y no hay entrenamiento contra la física que la gente jugó.
//!
//! El hash de acá tiene que coincidir con el que devuelve el mismo código
//! compilado a wasm — eso lo comprueba `scripts/wasm-determinism.sh`, y es lo
//! que delata una transcendental de plataforma colada en la simulación.

use engine::golden;
use engine::log;

/// Hash del mundo al final de la pelea guionada.
///
/// Si este número cambia, cambió el comportamiento del motor. No lo actualices
/// sin saber **qué** cambió: regenerá el fixture con
/// `cargo test --test dump_golden -- --ignored` solo después de entender el
/// diff.
const GOLDEN_HASH: u64 = 0xb803_e32f_85af_9150;

const FIXTURE: &[u8] = include_bytes!("golden/fight_0.bin");

#[test]
#[cfg_attr(feature = "dev", ignore = "el guion golden es de producción: con `dev` el boss se muere antes")]
fn el_hash_del_mundo_final_no_cambio() {
    assert_eq!(
        golden::golden_hash(),
        GOLDEN_HASH,
        "\nel motor dejó de producir el mundo de siempre.\n\
         si el cambio es intencional: cargo test --test dump_golden -- --ignored"
    );
}

#[test]
#[cfg_attr(feature = "dev", ignore = "el guion golden es de producción: con `dev` el boss se muere antes")]
fn el_log_guionado_no_cambio() {
    assert_eq!(log::encode(&golden::script()), FIXTURE, "el log guionado cambió");
}

/// Tick por tick, no solo el final: así el fallo señala el frame exacto donde
/// diverge en vez de dejarte con "el hash no da".
#[test]
fn dos_corridas_dan_el_mismo_estado_tick_a_tick() {
    let log = log::decode(FIXTURE).unwrap();
    let a = golden::trace(&log);
    let b = golden::trace(&log);
    assert_eq!(a.len(), b.len(), "las dos corridas duraron distinto");
    for (tick, (x, y)) in a.iter().zip(&b).enumerate() {
        assert_eq!(x, y, "divergen en el tick {tick}");
    }
    // Lo único que este número tiene que garantizar es que la comparación de
    // arriba no sea vacía. **No se ata a `BOSS_HP`**: ése es una perilla de
    // calibración, y con el umbral pegado a su valor este test se caía cada vez
    // que alguien bajaba la vida del boss para iterar — un fallo que no dice
    // nada sobre determinismo, que es lo único que el archivo mide.
    assert!(a.len() > 200, "la pelea es demasiado corta para probar nada");
}

/// El log tiene que ser una descripción completa de la pelea: re-simularlo
/// desde cero da el mismo mundo. Es el núcleo de lo que T8 envuelve.
#[test]
#[cfg_attr(feature = "dev", ignore = "el guion golden es de producción: con `dev` el boss se muere antes")]
fn el_log_reconstruye_la_pelea_entera() {
    let original = golden::script();
    let ida_y_vuelta = log::decode(&log::encode(&original)).unwrap();
    assert_eq!(ida_y_vuelta, original, "el log no sobrevive al ida y vuelta");
    assert_eq!(
        engine::hash_world(&golden::simulate(&ida_y_vuelta)),
        GOLDEN_HASH,
        "el log decodificado simula otra pelea"
    );
}

#[test]
fn el_fixture_cabe_en_el_presupuesto() {
    assert!(FIXTURE.len() < 10 * 1024, "{} bytes", FIXTURE.len());
}

/// Un golden test que pasa sobre 3600 ticks de dar vueltas no prueba nada. Esto
/// verifica que la pelea guionada sigue ejercitando lo que dice ejercitar.
#[test]
#[cfg_attr(feature = "dev", ignore = "el guion golden es de producción: con `dev` el boss se muere antes")]
fn el_guion_ejercita_el_motor_entero() {
    let r = golden::resumen();
    assert!(r.ticks > 1500, "pelea de {} ticks", r.ticks);

    for (i, nombre) in ["martillo", "cañón", "onda", "embestida"].iter().enumerate() {
        assert!(r.golpes[i] > 0, "{nombre} nunca acertó");
        assert!(r.whiffs[i] > 0, "{nombre} nunca falló: falta la señal de whiff");
    }
    assert!(r.telegrafias >= 15, "solo {} telegrafías", r.telegrafias);
    assert_eq!(r.cajas_movidas, 2, "los cuerpos dinámicos no se ejercitaron");
    assert!(r.boss_hp < 1000, "el jugador nunca le pegó al boss");
    assert!(r.player_hp <= 0, "la pelea tenía que terminar en muerte");
}

/// Imprime el hash nativo para que `scripts/wasm-determinism.sh` lo compare
/// contra el de wasm.
#[test]
#[ignore]
fn print_hash() {
    println!("HASH=0x{:016x}", golden::golden_hash());
}
