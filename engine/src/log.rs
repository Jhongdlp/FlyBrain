//! T6 — Log de pelea bitpackeado.
//!
//! **Frontera de confianza**: esto llega del cliente, que puede mentir o estar
//! roto. Todo campo se valida en el decode y ningún largo se cree sin
//! comprobarlo.
//!
//! El log guarda solo los ticks donde la entrada *cambia*: una pelea de 60
//! segundos son ~400 cambios, no 3600 fotogramas. El resto se reconstruye
//! simulando, que es lo que hace T8.
//!
//! ## El log define el espacio de acciones
//!
//! Las direcciones y el parámetro de bajo nivel viajan cuantizados. Para que el
//! replay del servidor coincida bit a bit con lo que corrió el navegador, la
//! simulación tiene que consumir **los mismos valores discretos**: el cliente
//! arma su `PlayerInput` con [`player_dir`] y el cerebro elige su parámetro con
//! [`dequant`]. Cuantizar en el encode y no en la simulación sería exactamente
//! el bug que el verificador existe para atrapar.

use crate::types::{BossAction, MinionKind, PlayerAction, PlayerInput, ToolId, Vec2};
use crate::weapons::{WAVE_MAX_R, WAVE_MIN_R};

pub const FORMAT_VERSION: u16 = 4;

/// 2 minutos a 60fps. Más que eso es implausible y se rechaza.
pub const MAX_TICKS: u32 = 7200;
pub const MAX_RECORDS: u32 = MAX_TICKS;

/// Direcciones del jugador: 8, las que produce un teclado.
pub const N_PLAYER_DIRS: u8 = 8;
/// Direcciones del boss: 64. La política se mueve más fino que el jugador.
pub const N_BOSS_DIRS: u8 = 64;

const HEADER: usize = 40;

#[derive(Debug, PartialEq, Eq)]
pub enum LogError {
    UnknownVersion,
    Truncated,
    /// Sobran bytes: el largo declarado no cuadra con el contenido.
    TrailingBytes,
    OutOfRange,
    TooLong,
}

/// Un cambio de entrada. Entre dos records la entrada se mantiene.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Record {
    pub tick: u32,
    pub input: PlayerInput,
    pub action: BossAction,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FightLog {
    pub version: u16,
    pub world_seed: u64,
    pub arena_id: u16,
    pub arena_seed: u64,
    pub brain_version: u32,
    /// Quién jugó, de forma anónima: un `u64` aleatorio que el navegador
    /// guarda en `localStorage`. **0 = sin id** (clientes viejos, tests).
    ///
    /// No es identidad ni sirve para confiar en nadie: el cliente lo elige y
    /// puede rotarlo cuando quiera, así que ninguna decisión de aceptar o
    /// rechazar una pelea puede depender de esto. Es exclusivamente para
    /// **agrupar peleas de la misma persona** en el análisis, y por eso tiene
    /// que estar desde el día uno: es el único dato del log que no se puede
    /// reconstruir después. Sin él, la fase 3 no puede clusterizar estilos (las
    /// 20 peleas de alguien son 20 puntos sueltos) y —peor— no hay forma de
    /// medir **explotabilidad**: si al que vuelve por décima vez le sigue
    /// costando. Esa es la métrica que dice si el boss es de verdad
    /// impredecible, y no se puede calcular hacia atrás.
    ///
    /// No es PII: no se pide, no se deriva del navegador y no identifica a
    /// nadie fuera de este juego.
    pub player_id: u64,
    /// Duración total. No se deduce del último record: la pelea sigue después
    /// del último cambio de entrada.
    pub ticks: u32,
    pub records: Vec<Record>,
}

// --- Cuantización ------------------------------------------------------------

/// Dirección canónica del jugador. El cliente arma su input con esto.
pub fn player_dir(i: u8) -> Vec2 {
    Vec2::from_angle(i as f32 * core::f32::consts::TAU / N_PLAYER_DIRS as f32)
}

pub fn boss_dir(i: u8) -> Vec2 {
    Vec2::from_angle(i as f32 * core::f32::consts::TAU / N_BOSS_DIRS as f32)
}

/// Índice de la dirección canónica más cercana. `n` debe ser potencia de dos.
pub fn dir_index(v: Vec2, n: u8) -> u8 {
    let a = v.angle(); // (-π, π]
    let turns = a / core::f32::consts::TAU;
    let i = libm::roundf(turns * n as f32) as i32;
    i.rem_euclid(n as i32) as u8
}

/// Un byte de entrada del jugador a `PlayerInput`. El navegador arma su input
/// con esto, así que la simulación consume exactamente los valores discretos
/// que después viajan en el log.
///
/// bit 7 contigüidad (lo usa el encode) · bits 4-6 acción · bit 3 movimiento ·
/// bits 0-2 dirección.
pub fn decode_player(p: u8) -> Result<PlayerInput, LogError> {
    let accion = (p >> 4) & 0x07;
    let action = match accion {
        0 => None,
        1..=4 => Some(PlayerAction::from_u8(accion - 1).ok_or(LogError::OutOfRange)?),
        _ => return Err(LogError::OutOfRange),
    };
    let move_dir = if p & 0x08 != 0 {
        player_dir(p & 0x07)
    } else {
        Vec2::ZERO
    };
    Ok(PlayerInput { move_dir, action })
}

/// Los dos bytes de la acción del boss: `[kind|payload, param]`. El segundo
/// se mira para `Use` y `Deploy`.
///
/// El slot de herramienta ocupa **tres** bits (4-5 no alcanzaban con la quinta
/// herramienta). Los tres de abajo siguen teniendo que venir en cero: es lo que
/// impide que un cliente cuele información en el relleno.
pub fn decode_boss(a: u8, param: u8) -> Result<BossAction, LogError> {
    Ok(match a >> 6 {
        0 => {
            if a & 0x3f != 0 {
                return Err(LogError::OutOfRange); // relleno sucio
            }
            BossAction::Idle
        }
        1 => BossAction::Move(boss_dir(a & 0x3f)),
        2 => {
            if a & 0x07 != 0 {
                return Err(LogError::OutOfRange);
            }
            let t = ToolId::from_u8((a >> 3) & 0x07).ok_or(LogError::OutOfRange)?;
            BossAction::Use(t, dequant(t, param))
        }
        3 => {
            let kind = MinionKind::from_u8(a & 0x3f).ok_or(LogError::OutOfRange)?;
            BossAction::Deploy(kind, dequant_support(param))
        }
        _ => return Err(LogError::OutOfRange),
    })
}

pub fn dequant_support(b: u8) -> f32 {
    b as f32 * core::f32::consts::TAU / 256.0
}

pub fn quant_support(p: f32) -> u8 {
    let turns = p / core::f32::consts::TAU;
    (libm::roundf(turns * 256.0) as i32).rem_euclid(256) as u8
}

/// El parámetro de bajo nivel como byte: ángulo para todas menos la onda, donde
/// es el radio. Es el espacio que la política de bajo nivel explora.
pub fn dequant(t: ToolId, b: u8) -> f32 {
    if t == ToolId::Wave {
        WAVE_MIN_R + (b as f32 / 255.0) * (WAVE_MAX_R - WAVE_MIN_R)
    } else {
        b as f32 * core::f32::consts::TAU / 256.0
    }
}

pub fn quant(t: ToolId, p: f32) -> u8 {
    if t == ToolId::Wave {
        let n = (p - WAVE_MIN_R) / (WAVE_MAX_R - WAVE_MIN_R);
        libm::roundf(n.max(0.0).min(1.0) * 255.0) as u8
    } else {
        let turns = p / core::f32::consts::TAU;
        (libm::roundf(turns * 256.0) as i32).rem_euclid(256) as u8
    }
}

// --- Encode ------------------------------------------------------------------

pub fn encode(log: &FightLog) -> Vec<u8> {
    let mut o = Vec::with_capacity(HEADER + log.records.len() * 3);
    o.extend_from_slice(&log.version.to_le_bytes());
    o.extend_from_slice(&log.world_seed.to_le_bytes());
    o.extend_from_slice(&log.arena_id.to_le_bytes());
    o.extend_from_slice(&log.arena_seed.to_le_bytes());
    o.extend_from_slice(&log.brain_version.to_le_bytes());
    o.extend_from_slice(&log.ticks.to_le_bytes());
    o.extend_from_slice(&(log.records.len() as u32).to_le_bytes());
    o.extend_from_slice(&log.player_id.to_le_bytes());
    debug_assert_eq!(o.len(), HEADER);

    let mut prev: i64 = -1;
    for r in &log.records {
        // bit 7: el record es contiguo al anterior y no lleva varint de delta.
        let delta = r.tick as i64 - prev;
        let contiguo = delta == 1;
        prev = r.tick as i64;

        let accion = r.input.action.map_or(0, |a| a as u8 + 1);
        let mueve = r.input.move_dir.len_sq() > 0.0;
        let dir = if mueve {
            dir_index(r.input.move_dir, N_PLAYER_DIRS)
        } else {
            0
        };
        o.push((contiguo as u8) << 7 | accion << 4 | (mueve as u8) << 3 | dir);

        if !contiguo {
            varint(&mut o, delta as u64);
        }

        match r.action {
            BossAction::Idle => o.push(0),
            BossAction::Move(d) => o.push(1 << 6 | dir_index(d, N_BOSS_DIRS)),
            BossAction::Use(t, p) => {
                o.push(2 << 6 | (t as u8) << 3);
                o.push(quant(t, p));
            }
            BossAction::Deploy(kind, p) => {
                o.push(3 << 6 | kind as u8);
                o.push(quant_support(p));
            }
        }
    }
    o
}

fn varint(o: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        o.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    o.push(v as u8);
}

// --- Decode ------------------------------------------------------------------

pub fn decode(b: &[u8]) -> Result<FightLog, LogError> {
    if b.len() < HEADER {
        return Err(LogError::Truncated);
    }
    let version = u16::from_le_bytes([b[0], b[1]]);
    if version != FORMAT_VERSION {
        return Err(LogError::UnknownVersion);
    }
    let ticks = u32::from_le_bytes(b[24..28].try_into().unwrap());
    let n = u32::from_le_bytes(b[28..32].try_into().unwrap());
    if ticks > MAX_TICKS || n > MAX_RECORDS || n > ticks.max(1) {
        return Err(LogError::TooLong);
    }

    let mut c = Cur { b, i: HEADER };
    let mut records = Vec::with_capacity(n as usize);
    let mut prev: i64 = -1;

    for _ in 0..n {
        let p = c.byte()?;
        let contiguo = p & 0x80 != 0;
        let delta = if contiguo { 1 } else { c.varint()? as i64 };
        let tick = prev + delta;
        // Estrictamente creciente y dentro de la pelea declarada.
        if delta < 1 || tick >= ticks as i64 {
            return Err(LogError::OutOfRange);
        }
        prev = tick;

        let input = decode_player(p)?;

        let a = c.byte()?;
        let boss = decode_boss(
            a,
            if matches!(a >> 6, 2 | 3) {
                c.byte()?
            } else {
                0
            },
        )?;

        records.push(Record {
            tick: tick as u32,
            input,
            action: boss,
        });
    }

    if c.i != b.len() {
        return Err(LogError::TrailingBytes);
    }

    Ok(FightLog {
        version,
        world_seed: u64::from_le_bytes(b[2..10].try_into().unwrap()),
        arena_id: u16::from_le_bytes([b[10], b[11]]),
        arena_seed: u64::from_le_bytes(b[12..20].try_into().unwrap()),
        brain_version: u32::from_le_bytes(b[20..24].try_into().unwrap()),
        player_id: u64::from_le_bytes(b[32..40].try_into().unwrap()),
        ticks,
        records,
    })
}

struct Cur<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cur<'_> {
    fn byte(&mut self) -> Result<u8, LogError> {
        let v = *self.b.get(self.i).ok_or(LogError::Truncated)?;
        self.i += 1;
        Ok(v)
    }
    fn varint(&mut self) -> Result<u64, LogError> {
        let (mut v, mut shift) = (0u64, 0);
        loop {
            let x = self.byte()?;
            v |= ((x & 0x7f) as u64) << shift;
            if x & 0x80 == 0 {
                return Ok(v);
            }
            shift += 7;
            if shift > 21 {
                return Err(LogError::OutOfRange); // ningún delta legítimo es tan grande
            }
        }
    }
}

/// Expande los cambios a la entrada de cada tick. Es lo que consume el
/// verificador y el entrenamiento.
pub fn expand(log: &FightLog) -> Vec<(PlayerInput, BossAction)> {
    let mut out = Vec::with_capacity(log.ticks as usize);
    let mut cur = (PlayerInput::default(), BossAction::Idle);
    let mut next = 0;
    for tick in 0..log.ticks {
        while next < log.records.len() && log.records[next].tick == tick {
            cur = (log.records[next].input, log.records[next].action);
            next += 1;
        }
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    fn cabecera(records: Vec<Record>, ticks: u32) -> FightLog {
        FightLog {
            version: FORMAT_VERSION,
            world_seed: 0xDEAD_BEEF_CAFE_1234,
            arena_id: 0,
            arena_seed: 1,
            brain_version: 42,
            player_id: 0xA11CE_u64 << 32 | 7,
            ticks,
            records,
        }
    }

    /// Una pelea plausible: el jugador cambia de rumbo cada ~8 ticks, el boss
    /// se mueve y saca una herramienta de vez en cuando.
    fn pelea(ticks: u32) -> FightLog {
        let mut r = Rng::new(7);
        let mut records = Vec::new();
        let mut tick = 0;
        while tick < ticks {
            let dir = (r.next_below(N_PLAYER_DIRS as u32)) as u8;
            let action = PlayerAction::from_u8(r.next_below(6) as u8);
            let boss = match r.next_below(10) {
                0 => BossAction::Idle,
                1 => {
                    let t = ToolId::from_u8(r.next_below(4) as u8).unwrap();
                    BossAction::Use(t, dequant(t, r.next_below(256) as u8))
                }
                _ => BossAction::Move(boss_dir(r.next_below(N_BOSS_DIRS as u32) as u8)),
            };
            records.push(Record {
                tick,
                input: PlayerInput {
                    move_dir: player_dir(dir),
                    action,
                },
                action: boss,
            });
            tick += 1 + r.next_below(15);
        }
        cabecera(records, ticks)
    }

    #[test]
    fn ida_y_vuelta_es_identico() {
        let log = pelea(3600);
        assert_eq!(decode(&encode(&log)).unwrap(), log);
    }

    #[test]
    fn ida_y_vuelta_con_records_contiguos() {
        // Peor caso del bit de contigüidad: un cambio por tick.
        let mut r = Rng::new(3);
        let records = (0..600)
            .map(|tick| Record {
                tick,
                input: PlayerInput {
                    move_dir: player_dir(r.next_below(8) as u8),
                    action: None,
                },
                action: BossAction::Move(boss_dir(r.next_below(64) as u8)),
            })
            .collect();
        let log = cabecera(records, 600);
        assert_eq!(decode(&encode(&log)).unwrap(), log);
    }

    #[test]
    fn ida_y_vuelta_de_despliegue_de_apoyo() {
        let log = cabecera(
            vec![
                Record {
                    tick: 0,
                    input: PlayerInput::default(),
                    action: BossAction::Deploy(MinionKind::Guardian, dequant_support(37)),
                },
                Record {
                    tick: 12,
                    input: PlayerInput::default(),
                    action: BossAction::Deploy(MinionKind::Controller, dequant_support(199)),
                },
            ],
            60,
        );
        assert_eq!(decode(&encode(&log)).unwrap(), log);
    }

    #[test]
    fn una_pelea_de_60_segundos_pesa_menos_de_10kb() {
        let bytes = encode(&pelea(3600)).len();
        assert!(bytes < 10 * 1024, "{bytes} bytes");
    }

    /// Ni el peor caso posible —un cambio de entrada en cada uno de los 3600
    /// ticks— pasa de 10KB. Ahí es donde paga el bit de contigüidad.
    #[test]
    fn el_peor_caso_tambien_entra() {
        let mut r = Rng::new(11);
        let records = (0..3600)
            .map(|tick| Record {
                tick,
                input: PlayerInput {
                    move_dir: player_dir(r.next_below(8) as u8),
                    action: PlayerAction::from_u8(r.next_below(5) as u8),
                },
                action: BossAction::Move(boss_dir(r.next_below(64) as u8)),
            })
            .collect();
        let bytes = encode(&cabecera(records, 3600)).len();
        assert!(bytes < 10 * 1024, "{bytes} bytes");
    }

    /// Si la cuantización no fuera exacta, el replay del servidor divergiría
    /// del navegador y el verificador daría falsos positivos.
    #[test]
    fn la_cuantizacion_es_estable() {
        for i in 0..N_PLAYER_DIRS {
            assert_eq!(dir_index(player_dir(i), N_PLAYER_DIRS), i, "jugador {i}");
        }
        for i in 0..N_BOSS_DIRS {
            assert_eq!(dir_index(boss_dir(i), N_BOSS_DIRS), i, "boss {i}");
        }
        for t in [ToolId::Hammer, ToolId::Cannon, ToolId::Wave, ToolId::Charge] {
            for b in 0..=255u8 {
                assert_eq!(quant(t, dequant(t, b)), b, "{t:?} {b}");
            }
        }
    }

    #[test]
    fn expand_mantiene_la_entrada_entre_cambios() {
        let log = cabecera(
            vec![
                Record {
                    tick: 0,
                    input: PlayerInput::default(),
                    action: BossAction::Idle,
                },
                Record {
                    tick: 3,
                    input: PlayerInput {
                        move_dir: player_dir(2),
                        action: None,
                    },
                    action: BossAction::Move(boss_dir(10)),
                },
            ],
            6,
        );
        let f = expand(&log);
        assert_eq!(f.len(), 6);
        assert_eq!(f[0].1, BossAction::Idle);
        assert_eq!(f[2].1, BossAction::Idle);
        assert_eq!(f[3].1, BossAction::Move(boss_dir(10)));
        assert_eq!(f[5].1, BossAction::Move(boss_dir(10)));
    }

    // --- Frontera de confianza ---

    #[test]
    fn rechaza_version_desconocida() {
        let mut b = encode(&pelea(60));
        b[0] = 99;
        assert_eq!(decode(&b), Err(LogError::UnknownVersion));
    }

    #[test]
    fn rechaza_log_truncado_sin_panico() {
        let b = encode(&pelea(600));
        for corte in 0..b.len() {
            assert!(decode(&b[..corte]).is_err(), "corte en {corte}");
        }
    }

    #[test]
    fn rechaza_largo_inconsistente() {
        let mut b = encode(&pelea(600));
        b.push(0); // sobra un byte
        assert_eq!(decode(&b), Err(LogError::TrailingBytes));

        let mut b = encode(&pelea(600));
        b[28] = b[28].wrapping_add(1); // dice tener un record más
        assert!(decode(&b).is_err());
    }

    #[test]
    fn rechaza_duracion_implausible() {
        let mut log = pelea(60);
        log.ticks = MAX_TICKS + 1;
        assert_eq!(decode(&encode(&log)), Err(LogError::TooLong));
    }

    #[test]
    fn rechaza_campos_fuera_de_rango() {
        // Acción del jugador 7: no existe.
        let mut b = encode(&cabecera(
            vec![Record {
                tick: 0,
                input: PlayerInput::default(),
                action: BossAction::Idle,
            }],
            10,
        ));
        b[HEADER] |= 0x70;
        assert!(decode(&b).is_err());

        // Kind de boss 3: no existe.
        let mut b = encode(&cabecera(
            vec![Record {
                tick: 0,
                input: PlayerInput::default(),
                action: BossAction::Idle,
            }],
            10,
        ));
        b[HEADER + 1] = 0xC2;
        assert!(decode(&b).is_err());
    }

    #[test]
    fn rechaza_ticks_fuera_de_la_pelea() {
        let log = cabecera(
            vec![Record {
                tick: 0,
                input: PlayerInput::default(),
                action: BossAction::Idle,
            }],
            10,
        );
        let mut b = encode(&log);
        b[HEADER] &= 0x7f; // apaga contigüidad
        b.insert(HEADER + 1, 200); // delta 200 en una pelea de 10 ticks
        b[28..32].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode(&b), Err(LogError::OutOfRange));
    }

    #[test]
    fn no_asigna_por_un_contador_mentiroso() {
        let mut b = encode(&cabecera(vec![], 10));
        b[28..32].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode(&b), Err(LogError::TooLong));
    }
}
