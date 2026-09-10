//! EL contrato. Todo el juego pasa por estos tipos.
//!
//! CONGELADO tras el merge de T0: cambiar algo de acá obliga a coordinar con
//! todas las tareas en vuelo.

use crate::rng::Rng;

/// Paso fijo. Nunca delta time variable.
pub const DT: f32 = 1.0 / 60.0;

/// Slots de la tabla de acciones. El boss usa los **cinco** (cuatro armas y el
/// dash de esquiva); el jugador solo los cuatro primeros, así que le sobra uno
/// en `Actor::cooldowns`. Dos bytes por actor no valen una segunda constante ni
/// un array por lado.
pub const N_TOOLS: usize = 5;

// --- Perillas de calibración -------------------------------------------------
// Valores iniciales. Se afinan jugando, no razonando; viven todos acá para que
// afinarlos sea editar un bloque y no cazar constantes por el repo.
pub const PLAYER_HP: i32 = 100;

/// Vida del boss.
///
/// **Con la feature `dev` es 25, y ése es el número que corre cuando levantás
/// el entorno con `scripts/dev.sh`** — el script compila con `--features dev`.
/// Si bajás el valor de producción de acá abajo y el boss sigue aguantando lo
/// mismo, es que estabas editando la rama equivocada.
///
/// 66 son **exactamente tres cañonazos** (22 cada uno): el tercero lo deja en
/// 0, y `Actor::alive` es `hp > 0`. En golpes básicos son ocho.
///
/// Para recalibrarlo: el cañón pega 22 con cooldown de 180 ticks, así que tres
/// tiros son 6 segundos como mínimo aunque no falles ninguno; el ataque básico
/// pega 9 con cooldown de 24 (~22 de daño por segundo pegado al boss) y es lo
/// que acorta la pelea si te acercás.
///
/// El 1000 de producción **no está calibrado y no se puede ganar**: con uptime
/// perfecto —pegado al boss, sin esquivar nunca— el jugador hace 22.3 de daño
/// por segundo, o sea 45 segundos contra un tope de pelea de 60, mientras
/// recibe ~4.7 por segundo con 100 de vida. Muere a los ~21. Hay que bajarlo
/// antes de lanzar; el número lo decide jugar, no razonar.
///
/// **Cliente y verificador tienen que compilarse igual.** `scripts/build-wasm.sh
/// dev` construye los dos del mismo binario; si solo uno lleva la feature, el
/// servidor rechaza todas las peleas por `Mismatch`.
#[cfg(not(feature = "dev"))]
pub const BOSS_HP: i32 = 1000;
#[cfg(feature = "dev")]
pub const BOSS_HP: i32 = 66;
pub const PLAYER_RADIUS: f32 = 0.4;
pub const BOSS_RADIUS: f32 = 0.9;
pub const MAX_MINIONS: usize = 2;
pub const N_MINION_KINDS: usize = 2;

// --- Geometría ---------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub const fn new(x: f32, y: f32) -> Self {
        Vec2 { x, y }
    }
    pub fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
    pub fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
    pub fn scale(self, k: f32) -> Vec2 {
        Vec2::new(self.x * k, self.y * k)
    }
    pub fn dot(self, o: Vec2) -> f32 {
        self.x * o.x + self.y * o.y
    }
    pub fn len_sq(self) -> f32 {
        self.dot(self)
    }
    /// `sqrt` es exacto por IEEE 754 en toda plataforma: no necesita `libm`.
    pub fn len(self) -> f32 {
        self.len_sq().sqrt()
    }
    pub fn dist_sq(self, o: Vec2) -> f32 {
        self.sub(o).len_sq()
    }
    pub fn dist(self, o: Vec2) -> f32 {
        self.sub(o).len()
    }
    /// Vector nulo devuelve nulo — nunca NaN.
    pub fn normalized(self) -> Vec2 {
        let l = self.len();
        if l > 1e-6 {
            self.scale(1.0 / l)
        } else {
            Vec2::ZERO
        }
    }
    pub fn perp(self) -> Vec2 {
        Vec2::new(-self.y, self.x)
    }
    /// Ángulo en radianes. `libm`, no `f32::atan2`.
    pub fn angle(self) -> f32 {
        libm::atan2f(self.y, self.x)
    }
    pub fn from_angle(a: f32) -> Vec2 {
        Vec2::new(libm::cosf(a), libm::sinf(a))
    }
}

/// Rectángulo alineado a los ejes. No hay rotación de cuerpos en el motor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min: Vec2,
    pub max: Vec2,
}

impl Aabb {
    pub fn from_center(c: Vec2, half: Vec2) -> Self {
        Aabb {
            min: c.sub(half),
            max: c.add(half),
        }
    }
    pub fn center(&self) -> Vec2 {
        Vec2::new(
            (self.min.x + self.max.x) * 0.5,
            (self.min.y + self.max.y) * 0.5,
        )
    }
    pub fn contains(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
    pub fn overlaps(&self, o: &Aabb) -> bool {
        self.min.x <= o.max.x
            && self.max.x >= o.min.x
            && self.min.y <= o.max.y
            && self.max.y >= o.min.y
    }
}

/// Forma de un hitbox o de un decal de telegrafía. La misma para las dos cosas:
/// lo que el render dibuja es exactamente lo que va a golpear.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Circle {
        c: Vec2,
        r: f32,
    },
    /// Arco de martillo: sector centrado en `facing`, semiapertura `half_angle`.
    Arc {
        c: Vec2,
        r: f32,
        facing: f32,
        half_angle: f32,
    },
    /// Rectángulo orientado (embestida, proyectil): `half` es (largo, ancho)/2.
    Rect {
        c: Vec2,
        half: Vec2,
        facing: f32,
    },
}

// --- Arena -------------------------------------------------------------------

/// Inmutable durante la pelea. Es dato, no código (T3 la carga desde JSON).
#[derive(Clone, Debug, PartialEq)]
pub struct Arena {
    pub id: u16,
    pub seed: u64,
    /// La arena ocupa (0,0)..(size.x, size.y).
    pub size: Vec2,
    pub statics: Vec<Aabb>,
    pub spawn_player: Vec2,
    pub spawn_boss: Vec2,
    /// Estado inicial de los cuerpos empujables.
    pub dynamics: Vec<DynBody>,
}

/// Caja empujable. Masa finita, sin rotación, sin apilamiento.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynBody {
    pub pos: Vec2,
    pub vel: Vec2,
    pub half: Vec2,
    pub mass: f32,
    /// `i32::MAX` = indestructible. La cobertura destructible es fase 3.
    pub hp: i32,
}

impl DynBody {
    pub fn aabb(&self) -> Aabb {
        Aabb::from_center(self.pos, self.half)
    }
}

// --- Actores -----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Player,
    Boss,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Player => Side::Boss,
            Side::Boss => Side::Player,
        }
    }
}

/// Herramientas del boss. El índice es su slot de cooldown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ToolId {
    Hammer = 0,
    Cannon = 1,
    Wave = 2,
    Charge = 3,
    /// Esquiva con impulso. **No hace daño**: es la primera decisión defensiva
    /// que el boss tiene, y existe porque hasta ahora solo podía elegir entre
    /// atacar y esperar — sin una alternativa que no sea atacar no hay forma de
    /// que aprenda que un ataque le sale caro.
    ///
    /// Va como herramienta y no como reflejo automático a propósito: así es un
    /// brazo del bandit y **cuándo** esquivar se aprende, en vez de ser un
    /// script. Lo que no se aprende es *si hay algo que esquivar*: eso es
    /// geometría: si hay algo que esquivar se resuelve con una resta, no con
    /// una política.
    Dash = 4,
}

/// Acciones discretas del jugador. Cerradas: el set no crece en el MVP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PlayerAction {
    Attack = 0,
    Dodge = 1,
    Parry = 2,
    Ability = 3,
}

/// Slot de acción dentro de la tabla del actor que la ejecuta: `ToolId` para el
/// boss, `PlayerAction` para el jugador. Un solo state machine para los dos.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActId(pub u8);

impl ToolId {
    pub fn act(self) -> ActId {
        ActId(self as u8)
    }
    pub fn from_u8(v: u8) -> Option<ToolId> {
        match v {
            0 => Some(ToolId::Hammer),
            1 => Some(ToolId::Cannon),
            2 => Some(ToolId::Wave),
            3 => Some(ToolId::Charge),
            4 => Some(ToolId::Dash),
            _ => None,
        }
    }
}

impl PlayerAction {
    pub fn act(self) -> ActId {
        ActId(self as u8)
    }
    pub fn from_u8(v: u8) -> Option<PlayerAction> {
        match v {
            0 => Some(PlayerAction::Attack),
            1 => Some(PlayerAction::Dodge),
            2 => Some(PlayerAction::Parry),
            3 => Some(PlayerAction::Ability),
            _ => None,
        }
    }
}

/// `Idle → Windup → Active → Recovery → Idle`, más `Dodging`.
/// Los ticks los pone la tabla de frame data de T4/T5, no este enum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ActorState {
    Idle,
    Windup {
        act: ActId,
        param: f32,
        ticks_left: u16,
    },
    Active {
        act: ActId,
        param: f32,
        ticks_left: u16,
    },
    Recovery {
        ticks_left: u16,
    },
    /// `iframes_left` corre en paralelo y puede terminar antes que el dodge.
    Dodging {
        ticks_left: u16,
        iframes_left: u16,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Actor {
    pub pos: Vec2,
    pub vel: Vec2,
    pub radius: f32,
    pub hp: i32,
    /// Radianes. Se gira con `Vec2::from_angle`, nunca con `f32::cos`.
    pub facing: f32,
    pub state: ActorState,
    /// En ticks. Bajan uno por `step`.
    pub cooldowns: [u16; N_TOOLS],
}

impl Actor {
    pub fn new(pos: Vec2, radius: f32, hp: i32) -> Self {
        Actor {
            pos,
            vel: Vec2::ZERO,
            radius,
            hp,
            facing: 0.0,
            state: ActorState::Idle,
            cooldowns: [0; N_TOOLS],
        }
    }
    pub fn alive(&self) -> bool {
        self.hp > 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projectile {
    pub pos: Vec2,
    pub vel: Vec2,
    pub radius: f32,
    pub damage: i32,
    /// Ticks de vida restantes. 0 = se borra este step.
    pub ttl: u16,
    pub owner: Side,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MinionKind {
    Guardian = 0,
    Controller = 1,
}

impl MinionKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Guardian),
            1 => Some(Self::Controller),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Minion {
    pub pos: Vec2,
    pub vel: Vec2,
    pub radius: f32,
    pub hp: i32,
    pub kind: MinionKind,
    pub ttl: u16,
    pub cooldown: u16,
}

impl Minion {
    pub fn alive(&self) -> bool {
        self.hp > 0 && self.ttl > 0
    }
}

// --- Entradas ----------------------------------------------------------------

/// `move_dir` normalizado (o nulo). `action` es `None` cuando no se pulsó nada.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlayerInput {
    pub move_dir: Vec2,
    pub action: Option<PlayerAction>,
}

/// El motor NO decide esto: `step` la recibe. Quién la elige (bandit, red,
/// script de test) es problema de quien llama.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BossAction {
    Idle,
    Move(Vec2),
    /// El `f32` es el parámetro de bajo nivel de la herramienta (ángulo o
    /// distancia); es lo que el modelo aprende a afinar.
    Use(ToolId, f32),
    /// Despliega un apoyo en la dirección cuantizada del parámetro.
    Deploy(MinionKind, f32),
}

// --- Salidas -----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    /// Emitido al entrar en `Windup`. Obligatorio: sin telegrafía el boss se
    /// siente injusto (principio 2 de CLAUDE.md).
    Telegraph {
        by: Side,
        act: ActId,
        shape: Shape,
    },
    Hit {
        by: Side,
        act: ActId,
        damage: i32,
    },
    /// Ataque que terminó sin tocar a nadie. La señal de aprendizaje más
    /// importante que tenemos.
    Whiff {
        by: Side,
        act: ActId,
    },
    Parried {
        by: Side,
        act: ActId,
    },
    /// El golpe llegó pero se lo comieron los i-frames de una esquiva. No es un
    /// whiff —la puntería estuvo bien— pero **sí** es un fallo de elección de
    /// herramienta: si en este contexto siempre te la esquivan, es la
    /// herramienta equivocada, y esa es justo la pregunta que responde el
    /// bandit.
    Absorbed {
        by: Side,
        act: ActId,
    },
    Death {
        who: Side,
    },
    MinionSpawned {
        kind: MinionKind,
    },
    MinionDespawned {
        kind: MinionKind,
    },
    MinionHit {
        kind: MinionKind,
        damage: i32,
    },
    GuardianAbsorbed {
        amount: i32,
    },
    ControllerSlowed {
        kind: MinionKind,
    },
}

/// `Vec` vacío no asigna, y la mayoría de los ticks no emite nada — no hace
/// falta buffer de capacidad fija.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StepEvents {
    pub events: Vec<Event>,
}

impl StepEvents {
    pub fn push(&mut self, e: Event) {
        self.events.push(e);
    }
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

// --- Mundo -------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct World {
    pub tick: u32,
    pub rng: Rng,
    pub arena: Arena,
    pub player: Actor,
    pub boss: Actor,
    pub projectiles: Vec<Projectile>,
    pub dynamics: Vec<DynBody>,
    pub minions: Vec<Minion>,
    pub minion_cooldowns: [u16; N_MINION_KINDS],
}

impl World {
    pub fn new(arena: Arena, seed: u64) -> Self {
        World {
            tick: 0,
            rng: Rng::new(seed),
            player: Actor::new(arena.spawn_player, PLAYER_RADIUS, PLAYER_HP),
            boss: Actor::new(arena.spawn_boss, BOSS_RADIUS, BOSS_HP),
            projectiles: Vec::new(),
            dynamics: arena.dynamics.clone(),
            minions: Vec::with_capacity(MAX_MINIONS),
            minion_cooldowns: [0; N_MINION_KINDS],
            arena,
        }
    }

    pub fn over(&self) -> bool {
        !self.player.alive() || !self.boss.alive()
    }
}
