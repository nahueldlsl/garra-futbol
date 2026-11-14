# Especificaciones Técnicas de Ingeniería Inversa — Garra Fútbol (`SPECS.md`)

> **Fase 3 — Metodología de Ingeniería Inversa**
> **Binario analizado:** `garrafut.exe` (PE32 x86, ImageBase `0x400000`)
> **SHA-256:** `d4d4ce21bea2f39b9a989c101a5b89eb0c1d97298af24185dfeb4877af1269c5`
> **Secciones PE:** `.text` (`VA=0x401000`, `VSize=0xf218f`, `Raw=0x400`), `.rdata` (`VA=0x4f4000`, `VSize=0x37268`, `Raw=0xf2600`), `.data` (`VA=0x52c000`, `VSize=0x1643c`, `Raw=0x129a00`).

---

## 1. Loop Principal, Tiempos y Máquinas de Estados

### 1.1 Inicialización y Game Loop (`sub_401000` @ `0x401000`, `sub_4012e0` @ `0x4012e0`, `sub_4696b0` @ `0x4696b0`, `sub_469ea0` @ `0x469ea0`, `sub_46a0c0` @ `0x46a0c0`)

| Parámetro | Dirección / Offset | Valor Exacto | Descripción |
| :--- | :--- | :--- | :--- |
| Resolución virtual (ancho) | `dword_539f10` @ `0x539f10` | `400.0f` px | Ancho lógico del viewport interno |
| Resolución virtual (alto) | `dword_539f14` @ `0x539f14` | `300.0f` px | Alto lógico del viewport interno |
| Ventana nativa por defecto | `sub_401000` @ `0x401000` | `800 x 600` (`scale = 2`) | Factor de escala inicial 2x sobre `400x300` |
| Frecuencia máxima del bucle | `config + 0x38` / `app + 0x20` | `100` Hz (`0x64`) / `0.01f` s | Intervalo mínimo entre iteraciones |
| **Fixed Logic Timestep** | `config + 0x2c` / `app + 0x10` | `1.0f / 30.0f` (`0x3d088889 = 0.033333335f` s) | **30 Hz** fijos de actualización lógica |
| **Max `dt` Clamp** | `app + 0x0c` | `1.0f / 30.0f` (`0.033333335f` s) | Tope máximo de `dt` por paso de frame |
| Paso secundario | `config + 0x30` / `app + 0x14` | `1.0f / 60.0f` (`0x3c888889`) | Referencia de 60 Hz |
| Escala temporal base | `config + 0x34` / `app + 0x18` | `1.0f` | Multiplicador base del reloj de la app |

---

### 1.2 Opciones de Juego y Escala de Velocidad

- **Estructura `GameOptions`** (`*dword_541110`, constructor `sub_464490` @ `0x464490`):
  - `+0x04`: Índice de duración de partido (`0..3`, por defecto `0`).
  - `+0x08`: Índice de velocidad de juego (`0..3`, por defecto `1`).
  - `+0x0c`: Duración total del partido en minutos (por defecto `6`; opciones en `menu.xml`: `3`, `6`, `10`, `15` minutos).
  - `+0x10`: Estado de sonido/música (`0` = sonido activo).
  - `+0x14`: Tipo de cancha (`0` o `1`).

- **Escalado de `dt` de simulación en `SoccerField`** (`sub_42f290` @ `0x42f290`):
  El `dt` pasado a la física de jugadores y pelota se multiplica según `GameOptions + 0x08`:

| Índice | Etiqueta en Menú | Multiplicador de `dt` | IEEE-754 Hex |
| :---: | :--- | :---: | :--- |
| `0` | *Lento* | `0.65f` | `0x3f266666` |
| `1` | *Normal* (default) | `0.75f` | `0x3f400000` |
| `2` | *Rápido* | `1.00f` | `0x3f800000` |
| `3` | *Recontra rápido* | `1.15f` | `0x3f933333` |

- **Compensación de tiempo real** (`sub_42f320` @ `0x42f320`):
  Tanto `SoccerClock::update` (`0x426f40`) como los temporizadores de espera de `SoccerField` (`0x42a010`) dividen el `dt` escalado por el mismo factor (`0.65`, `0.75`, `1.0`, `1.15`). De este modo, **el reloj del partido y las pausas corren en segundos reales de reloj de pared** independientemente de la velocidad física elegida.

---

### 1.3 Reloj del Partido (`SoccerClock`)

Ubicado en `soccerField + 0x1120` (inicializado en `0x428d74..0x428dc0`, actualizado en `sub_426f40` @ `0x426f40`):
- **`+0x16c` (`halfDurationSeconds`)**: `(GameOptions.matchMinutes * 0.5) * 60.0`
  - Partido de `3` min -> **`90.0f` s** por tiempo.
  - Partido de `6` min (default) -> **`180.0f` s** por tiempo.
  - Partido de `10` min -> **`300.0f` s** por tiempo.
  - Partido de `15` min -> **`450.0f` s** por tiempo.
- **`+0x170` (`elapsedSeconds`)**: avanza en segundos reales (`dt_real * timeScale`). En `SoccerHud` (`0x42f3f0`), el tiempo transcurrido se formatea como `MM:SS` mapeado a `45` minutos simbólicos por tiempo (1er tiempo `00:00..45:00`, 2do tiempo `45:00..90:00`).
- **`+0x178` (`isExpired`)**: bandera booleana que pasa a `1` cuando `elapsedSeconds >= halfDurationSeconds`.

---

### 1.4 Máquina de Estados Global (`bat::AppState`, RTTI en `.rdata`)

Flujo completo de pantallas/estados de la aplicación:

```text
LoadingState (0x45a5b0)
  └──▶ LogoState (0x45b200)
        └──▶ MainScreenState (0x45bda0) [árbol menu.xml]
              └──▶ TeamSelectionState (0x45edf0)
                    └──▶ VersusState (0x45fdb0)
                          └──▶ PresentationState (0x45dc10)
                                └──▶ SoccerState (0x45e8a0)
                                      └──▶ WinnerState (0x461910)
```

---

### 1.5 Máquina de Estados Interna del Partido (`SoccerField + 0x129c`)

Actualizada en `sub_42a280` (`0x42a280`), asignada en `sub_42c9d0` (`0x42c9d0`), con despacho de eventos en `sub_42bef0` (`0x42bef0`):

| Estado (`+0x129c`) | Nombre Simbólico | Función / Handler | Comportamiento y Transiciones |
| :---: | :--- | :--- | :--- |
| **`1`** | `PLAYING` | `sub_42a280` @ `0x42a280` | Juego en curso. Ejecuta chequeo de goles, postes, redes y límites del balón (`sub_42adf0` @ `0x42adf0`), colisiones entre jugadores (`sub_42ca60` @ `0x42ca60`) y sujeción de jugadores al campo (`sub_42ccc0` @ `0x42ccc0`). |
| **`2`** | `STOPPED_WAIT` | `0x42a010` | Mantiene física activa mientras descuenta `stateTimer` (`+0x12a0`) en segundos reales: **`1.0f` s** para saque de banda/córner/arco; **`3.0f` s** para gol (`+0x1110 = 1`) o fin de tiempo (`+0x1112 = 1`). Al llegar a `<= 0`: si `isGoal != 0` pasa a Estado `5` (`5.0f` s); si no, dispara *fade-to-black* (`sub_463940`) hacia Estado `3`. |
| **`3`** | `PRE_SET_PIECE` | `0x42a190` | Reposiciona cámara, pelota y los 22 jugadores (`sub_42cf90` @ `0x42cf90`, `sub_43b3f0` @ `0x43b3f0`) para saque de centro (`0x42a550`), lateral (`0x42a6a0`), córner (`0x43c4b0`) o saque de arco (`0x43cc60`), o lanza el diálogo de entretiempo (`"secondHalf"` @ `0x42d0bc`). |
| **`4`** | `DIALOG_WAIT` | `0x428b00`, `sub_45e8a0` | Espera de cartel/diálogo (`kickOff`, `secondHalf`, o menú de pausa `SoccerPauseMenu` @ `0x431750`). |
| **`5`** | `GOAL_CELEBRATION_BANNER` | `0x42a0c0` | La cámara sigue al goleador (`+0x1118`), actualiza y muestra `SoccerGoalMessage` (`+0xbbc`) durante **`5.0f` s** reales y hace fade hacia Estado `3` (saque de centro). |
| **`6`** | `MATCH_END_DELAY` | `0x429e60` | Cuenta atrás **`1.0f` s**, reproduce silbato final e instancia `SoccerEndDialog` (`0x463650`). Gestiona continuidad en Copa Calcar o menú `endMatchMenu`. |

**Códigos de evento en `sub_42bef0(eventCode)` (`0x42bef0`):**
- `3` = **Gol**
- `4` = **Saque de banda Norte** (`z < -720.0f`)
- `5` = **Saque de banda Sur** (`z > +720.0f`)
- `6` = **Salida por línea de fondo Oeste** (`x < -1440.0f`, decide entre córner Oeste o saque de arco)
- `7` = **Salida por línea de fondo Este** (`x > +1440.0f`, decide entre córner Este o saque de arco)
- `8` = **Tiempo expirado** (entretiempo o fin del partido)

---

## 2. Física del Balón, Jugadores, Geometría 3D y Cámara

### 2.1 Sistema de Coordenadas 3D y Proyección 2D (`sub_464a20` @ `0x464a20`, `sub_464ae0` @ `0x464ae0`)

Cada entidad física almacena su posición en `entity + 0x170..0x178`:
- **`x` (`+0x170`)**: Eje horizontal **Oeste–Este** (`0.0f` = centro del campo; línea de gol Oeste = **`-1440.0f`** @ `0x539ce0`; línea de gol Este = **`+1440.0f`** @ `0x539cec`).
- **`y` (`+0x174`)**: **Altura sobre el césped** (`y >= 0.0f`).
- **`z` (`+0x178`)**: Eje vertical en pantalla **Norte–Sur** (`0.0f` = centro del campo; banda Norte = **`-720.0f`** @ `0x539cc8`; banda Sur = **`+720.0f`** @ `0x539cd4`).

**Fórmula de proyección trapezoidal a pantalla 2D (`sub_464a20` @ `0x464a20`, coeficientes en `.rdata` `0x516df0..0x516e30`):**
```text
t        = 0.5 * (z / 720.0 + 1.0)
scaleX(z)= 0.75 + 0.25 * t          (0.75 en banda Norte z=-720, 0.875 en z=0, 1.00 en banda Sur z=+720)
screenX  = round(scaleX(z) * x)
screenY  = round(0.5 * z - y)
shadowX  = round(scaleX(z) * x)
shadowY  = round(0.5 * z)
```
*(La profundidad `z` escala horizontalmente los ejes del campo formando la vista perspectiva trapezoidal sobre `pitch1`/`pitch2`; la altura `y` se resta de `0.5 * z` para proyectar verticalmente en pantalla, mientras la sombra permanece en el césped en `(shadowX, shadowY)`. En `0x42dc00`, el poste/arco Norte se ordena en `z = -117.12` y el Sur en `z = +117.12` para el z-sorting entre arqueros, jugadores y redes).*

---

### 2.2 Integrador Cinemático 3D (`sub_478a60` @ `0x478a60`)

Estructura compartida en `entity + 0x170`:
- `+0x170..+0x178`: `pos` (`vec3`)
- `+0x17c..+0x184`: `vel` (`vec3`)
- `+0x188..+0x190`: `baseAcc` (`vec3`, ej. gravedad en `y`)
- `+0x194..+0x19c`: `dirAcc` (`vec3` unitario de dirección de empuje)
- `+0x1a0`: `driveAccMag` (`float`)
- `+0x1a4`: `maxSpeed` (`float`)
- `+0x1a8`: `linearFriction` (`float`)

**Algoritmo exacto por paso `dt`:**
```text
1. A = baseAcc + dirAcc * driveAccMag
   dirAcc = (0, 0, 0)
2. dP = vel * dt + 0.5 * A * dt^2
   if |dP| > maxSpeed * dt:
       dP = normalize(dP) * (maxSpeed * dt)
3. pos += dP
   vel += A * dt
4. newSpeed = |vel| - linearFriction * dt
   if newSpeed > 0:
       vel = normalize(vel) * newSpeed
   else:
       vel = (0, 0, 0)
5. if |vel| > maxSpeed:
       vel = normalize(vel) * maxSpeed
```

---

### 2.3 Física del Balón (`SoccerBall` en `soccerField + 0x658`, `0x425390..0x42679c`)

| Propiedad / Regla | Dirección / Offset | Valor / Fórmula | Descripción |
| :--- | :--- | :--- | :--- |
| Gravedad al soltarse | `ball + 0x18c` (`sub_425ce0` @ `0x425ce0`) | `-480.0f` px/s² (`0xc3f00000`) | Aceleración base en eje Y |
| Inmunidad de captura | `ball + 0x438` (`sub_425ce0`, `sub_425b40`) | `0.2f` s (`0x3e4ccccd`) | Impide recaptura inmediata tras patada/rebote |
| Fricción en el suelo (`pos.y == 0`) | `0x425667` | `linearFriction = 100.0f` px/s² (`0x42c80000`) | Desaceleración rodando por el césped |
| Arrastre aéreo (`pos.y > 0`) | `0x425684` | `linearFriction = 0.35f * |vel_3d|` | Resistencia aerodinámica (`0x3fd6666666666666`) |
| Coeficiente de restitución vertical | `ball + 0x440` (`0x4256a4`) | `0.65f` | Al tocar suelo (`pos.y <= 0 && vel.y <= 0`), `vel.y = -vel.y * 0.65f` y SFX `"picando"` |
| Umbral de detención de pique | `ball + 0x43c` (`0x4256a4`) | `20.0f` px/s | Si el nuevo `vel.y < 20.0f`: `pos.y = 0`, `vel.y = 0`, `baseAcc.y = 0`, y `(vel.x, vel.z) *= 0.65f` |
| Rebote contra jugador | `sub_425b40` @ `0x425b40` | `speed = 0.25 * |ball.vel|` | Si `|ball.vel| <= player.blockMaxSpeed` (`+0x70c = 700.0f`, escalado por `stat.block` si `+0x710 != 0`), refleja XZ en `normalize(ball.pos - player.pos)`, `vel.y *= 0.25f`, inmunidad `0.2f` s, `player->hasRebounded (+0x7b6) = 1` |
| Patada directa | `sub_425d40` @ `0x425d40` | `(vx, vz) = normalize(dirXZ) * horizSpeed`, `vy = vertSpeed` | Desacopla balón, guarda origen en `+0x444..0x44c` y recalcula `fallingPos` (`+0x524..0x52c`) en `sub_426590` (`0x426590`) |
| Patada parabólica a objetivo | `sub_425de0` @ `0x425de0` | Desvío aleatorio en `[-halfAngle, +halfAngle]` | Escalado por `stat.inaccuracy`, tope `0.9 * pi/2`; altura base `heightFactor * 63.08f` (`dword_539cd8`), tope máximo **`156.16f`** (`dword_539cdc`) |

---

### 2.4 Física del Jugador (`SoccerPlayer`) y Descriptor de Estado (`0xA4` bytes)

- **Tamaño de instancia `SoccerPlayer`:** `0x7d0` bytes (`sub_433240` @ `0x433240`, update `sub_433850` @ `0x433850`).
- **Descriptor de estado de `0xA4` bytes** (`sub_422740` @ `0x422740`), copiado en `player + 0x678..0x71b` por `sub_436c00` (`0x436c00`). Valores en estado normal de movimiento/juego (`test1` / `dicTest1.b` @ `0x4497e9..0x4498cb`):

| Parámetro | Offset en `SoccerPlayer` | Valor Base | Notas |
| :--- | :--- | :--- | :--- |
| `runAnimMinSpeed` | `+0x690` | `120.0f` | Umbral mínimo para ciclo de carrera |
| `animRefSpeed` | `+0x6a8` | `136.0f` | Velocidad de referencia de animación |
| `animSpeedFactor` | `+0x6b0` | `1.2f` | Multiplicador de velocidad de animación |
| `maxSpeed` | `+0x6b8` | `280.0f` px/s | Escalado por `stat.speed` cuando `+0x6bc = 1` |
| `driveAccMag` | `+0x6c0` | `2000.0f` px/s² | Aceleración al correr |
| `dribbleSpeedFactor` | `+0x6c4` | `0.8f` | Además, al conducir (`0x433c62`), `maxSpeed *= 0.8f` |
| `groundFriction` | `+0x6c8` | `800.0f` px/s² | Fricción al soltar dirección |
| `gravity` | `+0x6cc` | `1200.0f` px/s² | `baseAcc.y = -1200.0f` en el aire |
| `collisionRadius` | `+0x6d4` | `20.0f` px | Radio de colisión en plano XZ |
| `pushForce` | `+0x6d8` | `180.0f` | Fuerza de empuje en choque jugador-jugador |
| `pushReceptivity` | `+0x6dc` | `1.0f` | Factor de recepción de empuje |
| `ballPickupRadius` | `+0x6f8` | `16.0f` px | Radio de captura del balón |
| `dribbleLookaheadDist` | `+0x6fc` | `16.0f` px | Distancia por delante al conducir |
| `ballMaxPickupHeight` | `+0x700` | `20.0f` px | Altura máxima para controlar el balón con los pies |
| `ballPickupMaxSpeed` | `+0x708` | `37.0f` | Umbral para captura limpia vs rebote |
| `ballBlockMaxSpeed` | `+0x70c` | `700.0f` | Velocidad máxima de pelota bloqueable (escalado por `stat.block` si `+0x710 != 0`) |

- **Colisión jugador-jugador (`sub_42ca60` @ `0x42ca60`):** evalúa todos los pares entre los 22 jugadores en XZ; si `dist < r1 + r2` (`40.0f` px), aplica separación mutua proporcional a `pushForce * pushReceptivity * dt`.
- **Límites de cancha para jugadores (`sub_42ccc0` @ `0x42ccc0`):**
  - `x` clamped en **`[-1424.0f, +1424.0f]`**
  - `z` clamped en **`[-760.0f, +760.0f]`**

---

### 2.5 Acciones Ofensivas, Tiros, Barridas y Cabezazos (`GameScripts` @ `0x4494d0..0x457c3a`, `0x434a90..0x435646`)

- **Pase Raso (`passPerform` @ `0x44c731`, `sub_4354d0` @ `0x4354d0`) y Pase Alto (`passHigh` @ `0x454099`):**
  - Velocidad base: **`420.0f`** (`1138163712`), velocidad mínima: **`60.0f`** (`1114636288`), dispersión angular: `0.05 * pi`.
  - `passHigh` usa los mismos parámetros de velocidad añadiendo componente vertical parabólico.

- **Niveles de Tiro al Arco por carga del Botón A (`test2`/`test3` @ `0x44b800..0x452800`):**

| Nivel | Nombre Interno | Tiempo de Carga | Velocidad (`speed`) | `heightFactor` | Imprecisión | `extraAngle` / Efectos |
| :---: | :--- | :--- | :---: | :---: | :---: | :--- |
| **`kickLv0`** | *Picarla* | Tap `< 0.1s` en área rival | `394.0f` (`1137049601`) | `0.75f` | `0.05 * pi` | `maxHeight = -0.1 * pi` |
| **`kickLv1`** | *Tiro rápido y bajo* | `0.0s .. 0.1s` | `660.0f` (`1143275520`) | `0.10f` | `0.05 * pi` | `extraAngle = 0.0f` |
| **`kickLv2`** | *Tiro mediano* | `0.1s .. 0.3s` | `660.0f` (`1143275520`) | `0.80f` | `0.06 * pi` | `extraAngle = 16.0f` |
| **`kickLv3`** | *Tiro alto* | `0.3s .. 0.6s` | `990.0f` (`1148682240`) | `0.80f` | `0.05 * pi` | `extraAngle = 16.0f`; SFX `"powerKick"` + `"tribunaOvacion"` |
| **`kickLv4`** | *Bombazo / Super Tiro* | `>= 0.6s` | `1100.0f` (`1150312448`) | `1.00f` | `0.10 * pi` | `extraAngle = 64.0f` (`1115684864`); SFX `"powerKick"` + `"tribunaOvacion"` |

*(Nota: la potencia de disparo se escala por `stat.power` `+0x3c` cuando `player + 0x719 != 0` en `0x434de1`, y la imprecisión angular por `stat.inaccuracy` `+0x40` cuando `player + 0x71a != 0` en `0x434daa`).*

- **Cabezazo / Palomita (`buttHeadShotPrepare` @ `0x44e090`, `buttHeadShot` @ `0x44db7a`):**
  - Se activa cuando la altura del balón está en **`y in [40.0f, 100.0f]`** (`1109393408..1120403456`) y la distancia horizontal `< 190.0f` (`1128792064`).
  - Salto hacia la pelota: velocidad horizontal `230.0f`..`240.0f`, impulso vertical `vy = 160.0f`..`240.0f`.
  - Impacto al balón: remate al arco a `280.0f`..`300.0f` o pase de cabeza a `80.0f`..`90.0f`.

- **Barrida (`tackle` @ `0x44c9ea`):**
  - Impulso inicial: `vx = 320.0f` (`1134559232`), `vz = 60.0f` (`1114636288`), `groundFriction = 320.0f`.
  - `canStealFromOwner = 1`, `stealSuccessChance = 2.0f`.
  - Duración activa: **`0.25s`** (`1048576000`). Si no robó, transiciona al estado de recuperación `raise` durante **`0.35s`** (`1051931443`).

- **Esquive / Tropiezo (`evasion` @ `0x44d1f0`):**
  - Al sufrir un robo o intentar esquivar, ejecuta un salto `vy = 180.0f` (`1127481344`), pierde control durante `12.0f` frames (`0.4s`) y dispara reacción del público si ocurre en `zone == 3`.

---

### 2.6 Cámara (`SoccerCamera` en `soccerField + 0x600`, `0x4267a0`, `0x4268d0`, `0x426950`)

- **Seguimiento interpolado (`0x426950`):**
  ```text
  cam.pos += (target - cam.pos) * dt * 8.0f
  ```
- **Adelanto direccional (`leadOffset`, `0x4268d0` / `0x426950`):**
  Desplaza el foco de cámara hasta `+/-100.0f` px en la dirección de ataque (`currentLead` interpola hacia `leadDir` a razón de `2.0 * dt`).
- **Límites de cámara en mundo (`0x4268d0`):**
  - `camX` clamped en **`[-1240.0f, +1240.0f]`**
  - `camY` (`z`) clamped en **`[-570.0f, +570.0f]`**

---

## 3. Reglas y Arbitraje

### 3.1 Dimensiones Reglamentarias y Arcos (`0x539cc0..0x539f18`, `0x4f22d0..0x4f2550`)

- **Dimensiones totales del campo:** `2880.0f x 1440.0f` px lógica:
  - Línea de gol Oeste: **`x = -1440.0f`** (`0x539ce0`)
  - Línea de gol Este: **`x = +1440.0f`** (`0x539cec`)
  - Banda Norte: **`z = -720.0f`** (`0x539cc8`)
  - Banda Sur: **`z = +720.0f`** (`0x539cd4`)
- **Arcos (Oeste en `(-1440, 0, 0)` y Este en `(+1440, 0, 0)`):**
  - Postes en **`z = -117.12f`** (`0xc2ea3d71`) y **`z = +117.12f`** (`0x42ea3d71`) -> **ancho de boca de arco = `234.24f` px**.
  - Altura del travesaño: **`78.0f` px** (`2 * 39.0f`, centro geométrico en `y = 39.0f`; `halfHeight + radius = 39.5f` en `sub_42b100`).
  - Radio físico de postes y travesaño: **`5.0f` px** (`sub_42b100`).
  - Profundidad de red: **`117.12f` px** (`sub_42b100`).

---

### 3.2 Detección de Gol, Postes y Redes (`sub_42b430` @ `0x42b430`, `sub_42b100` @ `0x42b100`)

`sub_42b430` evalúa la intersección de segmento/caja entre `prevPos` y `pos` (`sub_42b100` y `sub_4648b0`):
1. **Postes verticales (`0x04`, `0x37`) y Travesaño (`0x29a`):**
   - Llama a `sub_426490(ball, 1)`: hace rebotar el balón multiplicando su velocidad por **`0.8f`**.
   - Reproduce SFX `"palo"` y `"tribunaSusto"`. Retorna `2` (el juego continúa).
2. **Redes laterales, trasera y superior (`0x14d`, `0x16`, `0x01`):**
   - Amortigua la velocidad multiplicándola por **`0.15f`** (`0x3e19999a`), revierte a `prevPos`, desacopla el balón si seguía sujeto y retorna `1`.
3. **Plano de Gol (`0x539d30` Oeste / `0x539da8` Este):**
   - Si el segmento cruza el plano dentro del vano del arco, retorna **`3`** -> dispara `sub_42bef0(3)` (**¡GOL!**): suma `1` al marcador del equipo anotador, reproduce `"gol"` y `"silbato"` y entra en secuencia de celebración (`Estado 2 -> Estado 5`).

---

### 3.3 Saques de Banda, Córners y Saques de Arco (`sub_42b3a0` @ `0x42b3a0`, `sub_42bef0` @ `0x42bef0`, `sub_43b3f0` @ `0x43b3f0`)

`sub_42b3a0` verifica el cruce de los cuatro planos límite de la cancha:
- **Banda Norte (`z < -720.0f` -> evento `4`) / Banda Sur (`z > +720.0f` -> evento `5`):**
  - Se ejecuta **Saque de Banda** (`sub_43b530` @ `0x43b530`) en el punto de salida `(ball.x, ±720)` para el equipo contrario al último jugador en tocar el balón (`ball + 0x434`).
- **Línea de fondo Oeste (`x < -1440.0f` -> evento `6`) / Línea de fondo Este (`x > +1440.0f` -> evento `7`):**
  - Si `ball.lastTouchTeam (+0x434)` es el equipo que **defiende** ese arco -> **Tiro de Esquina / Córner** (`sub_43c4b0` @ `0x43c4b0`).
  - Si `ball.lastTouchTeam` es el equipo **atacante** -> **Saque de Arco** (`sub_43cc60` @ `0x43cc60`).

---

### 3.4 Faltas, Tarjetas y Offside

Confirmado mediante inspección de `SoccerField` (`0x428a70..0x42d3a0`) y `GameScripts` (`0x4494d0..0x457c3a`):
- **No existen faltas, tiros libres, penales, tarjetas ni regla de fuera de juego (offside).**
- Toda barrida (`tackle`) y choque físico están permitidos sin penalización arbitral.

---

## 4. Inteligencia Artificial y Posicionamiento Táctico

### 4.1 Cálculo de Posición Táctica por Formación (`sub_438190` @ `0x438190`, `sub_42edd0` @ `0x42edd0`)

1. Se toma la posición predicha de caída del balón `ball.fallingPos` (`ball + 0x524`, `ball + 0x52c`) normalizada por las semidimensiones del campo:
   ```text
   normX = clamp(ball.fallingPos.x / 1440.0, -1.0, +1.0)
   normZ = clamp(ball.fallingPos.z / 720.0, -1.0, +1.0)
   ```
2. `sub_42edd0` proyecta una ventana táctica móvil centrada en el balón (aplicando un desplazamiento ofensivo/defensivo de `±60.0f` según el lado del equipo: `side == 1` vs `side == -1`, e invirtiendo ejes si `side == -1`), recortada dentro del campo `[-1440, +1440] x [-720, +720]`.
3. Las coordenadas normalizadas de cada rol definidas en `formations.xml` (`/src/data/formations.json`) se interpolan linealmente dentro de dicha ventana táctica para obtener el punto objetivo de cada jugador sin balón.

---

### 4.2 Selección de Jugador Activo / Receptor (`SoccerTeam::update` @ `0x437df0`, `sub_437770` @ `0x437770`)

- Cada equipo rastrea de forma continua al jugador de campo más cercano a `ball.fallingPos` (`team + 0x9c` / `+0xa0`), permitiendo la selección automática defensiva o el cambio manual con el botón `pass` (Botón B).
- Al ejecutar un pase (`sub_4354d0`), la IA/lógica elige el compañero mejor alineado con el vector de dirección del pasador.

---

### 4.3 Árboles de Decisión de IA de Campo (`GameScripts` @ `0x4494d0..0x454100`)

- **Sin posesión:**
  - Si es el jugador asignado al balón (`nearest`): persigue directamente al balón/portador (`chase`); si el rival con pelota entra en rango cercano ejecuta `tackle` (`0x44c9ea`), o prepara `buttHeadShotPrepare` (`0x44e090`) cuando la pelota está alta (`y in [40, 100]`, `dist < 190`).
  - Los demás compañeros se desplazan a su posición táctica calculada por `sub_438190`.
- **Con posesión (CPU):**
  - El campo se evalúa en 3 zonas longitudinales (`zone 1` defensa propia, `zone 2` mediocampo, `zone 3` ataque/área rival):
    - En **`zone 1` y `zone 2`**: conduce en dirección al arco rival esquivando rivales cercanos o ejecuta pase (`passPerform` / `passHigh`) a un compañero libre adelantado.
    - En **`zone 3` (peligro)**: según distancia y ángulo al arco rival, selecciona entre `kickLv0` (picarla frente al arquero), `kickLv1..kickLv4` (tiros con distintos niveles de altura y potencia) o centro hacia el área.

---

### 4.4 Lógica del Arquero (`goalkeeperStand` @ `0x45424b`, `goalkeeperJump` @ `0x4550cd`, `goalkeeperBestJump` @ `0x455ac7`, `goalkeeperTackle` @ `0x456904`, `goalkeeperKick` @ `0x4565fb`)

- **Posicionamiento base (`goalkeeperStand` @ `0x45424b`):**
  Se ubica entre el centro del arco propio y la trayectoria del balón con `pickupRadius = 10.0f`, `pickupMaxSpeed = 70.0f` (`1116471296`) y `maxPickupHeight = 30.0f`.
- **Atajada / Estirada (`goalkeeperJump` @ `0x4550cd`, `goalkeeperBestJump` @ `0x455ac7`):**
  - Se dispara cuando el balón se aproxima dentro de **`105.0f` px** (`1121058816`) hacia el arco.
  - Salta hacia la pelota a `speed = 190.0f`, `vy = 400.0f` (con impulsos extra `100.0f`/`450.0f` si `ball.y > 40.0f` o `310.0f`/`310.0f` si `ball.y > 60.0f`).
  - En `goalkeeperBestJump`, `catchMaxSpeed` alcanza **`1000.0f`** (`1148829696`).
- **Despeje del arquero (`goalkeeperKick` @ `0x4565fb`):**
  Tras atajar o atrapar la pelota, patea hacia el campo contrario con velocidad horizontal en `[120.0f, 650.0f]` (`1123024896..1143111680`) y velocidad vertical **`750.0f`** (`1144750080`).

---

### 4.5 Atributos de Jugadores (`sub_436380` @ `0x436380`)

Cada jugador de `SoccerTeam` posee un bloque de `0x44` (`68`) bytes (`index * 17 * 4`) donde los atributos enteros `0..10` de `teams.xml` (`/src/data/teams.json`) se almacenan como multiplicadores escalados en punto flotante:
- `+0x28`: **`skill`** -> afecta velocidad de giro (`0x434044`) y control de balón (`0x433850`).
- `+0x2c`: **`speed`** -> escala `maxSpeed` del jugador cuando `+0x6bc != 0` (`0x433850`).
- `+0x30`: **`marking`** -> modula la marcación defensiva sin balón.
- `+0x34`: **`drivingFail`** -> probabilidad/factor de error en conducción.
- `+0x38`: **`block`** -> escala el umbral de bloqueo/rebote `blockMaxSpeed` en `sub_425b40` cuando `+0x710 != 0`.
- `+0x3c`: **`power`** -> escala la potencia de tiro en `0x434de1` cuando `+0x719 != 0`.
- `+0x40`: **`inaccuracy`** -> escala el cono de imprecisión en `0x434daa` cuando `+0x71a != 0`.

---

## 5. Controles y Mapeo de Entradas

### 5.1 Vector de Dirección y Normalización Diagonal (`KeyboardControl::getDirection` @ `0x40f8d0`, `sub_467650` @ `0x467650`)

- Suma `-1.0f / +1.0f` en ejes X y Z según las 4 teclas direccionales activas.
- Cuando la norma al cuadrado es `> 0`, invoca `sub_467650` para normalizar el vector a longitud `1.0f`. Por ello, el movimiento diagonal siempre tiene componente **`±0.70710678f` (`1 / √2`)** en cada eje (sin incremento de velocidad en diagonal).

---

### 5.2 Perfiles de Teclado Registrados (`sub_444340` @ `0x444340`, `controles.png`, `controles2p.png`)

El motor codifica las teclas como **`DIK_scancode - 1`** (DirectInput scancodes menos 1). Los perfiles inicializados en `0x444340..0x444e5a` y verificados contra los gráficos oficiales de ayuda (`controles.png` y `controles2p.png`) son:

| Perfil | Movimiento (Arriba / Abajo / Izquierda / Derecha) | Acción Principal (`accept` / `shot` - Botón A) | Acción Secundaria (`cancel` / `pass` - Botón B) |
| :--- | :--- | :--- | :--- |
| **`"menu"`** | Flechas (`0x78` / `0x7d` / `0x7a` / `0x7b`) | **`Enter`** (`0x1b`) / **`Z`** (`0x2b`) | **`Escape`** (`0x00`) / **`X`** (`0x2c`) |
| **`"1P vs CPU"`** (Solo) | Flechas (`0x78` / `0x7d` / `0x7a` / `0x7b`) | **`Z`** (`0x2b`, `DIK_Z - 1`) | **`X`** (`0x2c`, `DIK_X - 1`) |
| **`"1P vs 2P"`** (J1 en 2P) | **`D`** (`0x1f`) / **`C`** (`0x2d`) / **`X`** (`0x2c`) / **`V`** (`0x2e`) | **`Q`** (`0x0f`, `DIK_Q - 1`) | **`W`** (`0x10`, `DIK_W - 1`) |
| **`"2P vs 1P"`** (J2 en 2P) | Flechas (`0x78` / `0x7d` / `0x7a` / `0x7b`) | **`.` / `:`** (`0x33`, `DIK_PERIOD - 1`) | **`-` / `_`** (`0x34`, `DIK_SLASH - 1`, tecla junto a `.` en teclado español) |
| **Pausa en partido** | — | — | **`Escape`** (`0x00`, abre `SoccerPauseMenu` en `0x45e8a0`) |

---

### 5.3 Comportamiento de Pulsación Corta vs. Mantenida, Picarla y Apuntado (`superTiro.png`, `pases.png`, `cabezazo.png`, `apuntar.png`)

| Contexto | Entrada | Corta (`tap`) | Mantenida (`hold`) / Modificadores Direccionales |
| :--- | :--- | :--- | :--- |
| **Con balón (tiro al arco)** | **Botón A (`shot`: `Z` / `Q` / `.`)** | `< 0.1s`: Si se presiona **hacia atrás** (dirección opuesta al arco rival) en área de definición -> **`kickLv0`** (*Picarla*, `394.0f`, `heightFactor = 0.75f`, más preciso pero más lento). En caso normal -> **`kickLv1`** (*Rápido y bajo*, `660.0f`). | Carga continua de potencia (`superTiro.png`): `0.1..0.3s` -> **`kickLv2`** (`660.0f`, medio/alto); `0.3..0.6s` -> **`kickLv3`** (`990.0f`); `>= 0.6s` -> **`kickLv4`** (*Super Tiro / Bombazo*, `1100.0f`). Mantener **Arriba** o **Abajo** en el instante del disparo apunta hacia los palos superior o inferior (`sub_434a90`, `apuntar.png`). |
| **Con balón (pase)** | **Botón B (`pass`: `X` / `W` / `-`)** | Presionar y soltar rápido ejecuta un **pase bajo** (**`passPerform`**, `420.0f`, `heightFactor = 0.0f`) hacia el compañero mejor alineado (`pases.png`). | Mantener presionada la tecla un instante antes de soltar ejecuta un **pase alto / centro** (**`passHigh`**, `420.0f` con arco vertical, `pases.png`). |
| **Balón aéreo (`y in [40, 100]`, `dist < 190`)** | **Botón A (`shot`) / Botón B (`pass`)** | Antes de recibir un pase alto (`cabezazo.png`), presionar **`shot`** cerca del arco rival ejecuta un **cabezazo potente al arco** (**`buttHeadShot`**, `280.0f..300.0f`); presionar **`pass`** ejecuta un **pase de cabeza**. | — |
| **Sin balón (defensa)** | **Botón A (`shot`: `Z` / `Q` / `.`)** | Ejecuta **barrida** (**`tackle`** @ `0x44c9ea`, `0.25s` de deslizamiento + `0.35s` de recuperación) para quitar el balón (`controles.png`). | — |
| **Sin balón (cambio)** | **Botón B (`pass`: `X` / `W` / `-`)** | **Cambia el control** al jugador del equipo más cercano al balón (`controles.png`). | — |
