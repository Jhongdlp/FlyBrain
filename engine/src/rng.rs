//! PRNG sembrado. La ÚNICA fuente de aleatoriedad del motor.
//!
//! PCG32 (XSH-RR). No se usa el crate `rand`: su algoritmo puede cambiar entre
//! versiones y eso rompería los replays viejos.

const MULT: u64 = 6364136223846793005;
const INC: u64 = 1442695040888963407;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut r = Rng { state: 0 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULT).wrapping_add(INC);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniforme en [0, 1). Exacto: 24 bits sobre 2^24, sin redondeo.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Entero en [0, n). Módulo sesgado: irrelevante para n chico (elección de
    /// herramienta, jitter de spawn) y determinista, que es lo que importa.
    pub fn next_below(&mut self, n: u32) -> u32 {
        debug_assert!(n > 0);
        self.next_u32() % n
    }

    /// Estado crudo — para hashear el mundo en el golden test (T7).
    pub fn state(&self) -> u64 {
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn misma_semilla_misma_secuencia() {
        let (mut a, mut b) = (Rng::new(42), Rng::new(42));
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn semillas_distintas_divergen() {
        let (mut a, mut b) = (Rng::new(1), Rng::new(2));
        assert_ne!(a.next_u32(), b.next_u32());
    }

    #[test]
    fn f32_en_rango() {
        let mut r = Rng::new(7);
        for _ in 0..10_000 {
            let v = r.next_f32();
            assert!((0.0..1.0).contains(&v));
        }
    }
}
