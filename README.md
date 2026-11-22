# BASS CHALLENGE

Dinámica interactiva para una presentación universitaria sobre el **Modelo de Difusión de Bass (1969)**
(asignatura *Comunicación, Innovación y Comportamiento del Consumidor*).

Toda la clase participa desde el móvil escaneando un código QR; el presentador controla las etapas
desde el ordenador conectado al proyector y los resultados aparecen en pantalla en tiempo real.

Duración aproximada: 5–10 minutos.

## Cómo funciona

| Etapa | Pantalla del presentador | Móvil de los participantes |
|---|---|---|
| 1. Entrada | QR, código de acceso, participantes y cuántos eligieron cada producto | Escriben un apodo y eligen SmartWatch X (€199), SoundPods (€149) o HoloMini (€299) |
| 2. Ronda 1 — Innovación (p) | Progreso de respuestas | «¿Comprarías este producto aun siendo de los primeros consumidores, sin saber si otras personas también lo comprarán?» |
| Resultados 1 | Adopción por producto | — |
| 3. Ronda 2 — Imitación (q) | Progreso de respuestas | Ven cuántos ya compraron y deciden si mantienen o cambian su decisión |
| Resultados 2 | Nuevas adopciones y adopción acumulada | — |
| 4. Ronda 3 — Saturación | Progreso de respuestas | Última oportunidad de compra |
| Final | Producto más elegido, adopción y %, evolución por ronda, curva S | Resumen personal |
| Modelo de Bass | Fórmula `f(t) = [p + qF(t)][1 − F(t)]`, p, q, saturación y curva teórica | — |

Controles del presentador: botón principal (avanzar / revelar resultados), **Atrás**, **Reiniciar**
(pide confirmación) y **QR** (muestra el código en grande para quien llegue tarde).
Mientras una ronda está abierta, cada participante puede cambiar su respuesta; al revelar los resultados queda fija.
Quien abra la web sin el QR puede escribir el **código de acceso** que aparece debajo del QR.
Atajos de teclado: `→` avanzar, `←` atrás, `Q` mostrar QR — funciona con un presentador de diapositivas.

> La votación de la clase es una demostración participativa simplificada, no una estimación
> estadística rigurosa de los parámetros p y q.

## Estructura

```
public/
  index.html        Pantalla de los participantes (móvil)
  presentador.html  Panel del presentador (proyector)
  common.js         Lógica compartida: productos, reglas, sincronización, estadísticas
  style.css         Estilos
  config.js         Configuración web de Firebase
  vendor/qrcode.js  Generador de QR (qrcode-generator, MIT)
server.js           Servidor local opcional (Node.js, sin dependencias)
firestore.rules      Reglas de seguridad de Cloud Firestore
vercel.json         Configuración de despliegue
```

La sincronización tiene dos modos, elegidos automáticamente:

- **Cloud Firestore** (si `public/config.js` tiene la configuración) → para publicarlo en **Vercel**.
- **Servidor local** (si `config.js` queda en `null`) → `node server.js` en el ordenador del presentador.

---

## Opción A — Publicar en Vercel con Cloud Firestore (recomendada)

Vercel solo aloja archivos estáticos, así que los datos se sincronizan con **Cloud Firestore**
(plan gratuito Spark, sin backend propio). Todas las pantallas escuchan los cambios con `onSnapshot`,
por eso el panel se actualiza en cuanto alguien vota.

**Modelo de datos**

```
sessions/{sid}                      { owner, stage, createdAt }       ← sesión creada por el presentador
sessions/{sid}/participants/{uid}   { name, product, v1, v2, v3, t }  ← un documento por móvil (votos de las 3 rondas)
```

**Seguridad** (`firestore.rules`)

- No hay registro ni contraseña. Cada dispositivo usa el **acceso anónimo** de Firebase, que es invisible
  para el usuario y solo sirve para darle un identificador (`uid`) que las reglas comprueban.
- Solo el navegador del presentador que creó la sesión puede cambiar la etapa o reiniciarla.
- Cada participante solo puede crear y modificar **su propio** documento.
- Cada voto solo puede escribirse o cambiarse **mientras su ronda está abierta**,
  y no se puede volver a «comprar» si ya se compró en una ronda anterior.
- Fuera de `sessions` todo queda cerrado; sin acceso anónimo no se puede leer ni escribir nada.
- En el frontend solo está la configuración web pública de Firebase (no es una credencial de administrador).

### 1. Activar Firebase (≈5 min, en el proyecto ya creado)

1. **Cloud Firestore**: <https://console.firebase.google.com> → tu proyecto → **Compilación → Firestore Database**
   → **Crear base de datos** → ubicación (p. ej. `eur3 (europe-west)`) → **Iniciar en modo de producción**.
   *(Si el proyecto ya tiene Firestore, sáltate este paso.)*
2. **Acceso anónimo**: **Compilación → Authentication** → **Comenzar** → pestaña **Método de inicio de sesión**
   → **Anónimo** → **Habilitar** → Guardar.
3. **Reglas**: **Firestore Database → pestaña Reglas** → pega el contenido de [`firestore.rules`](firestore.rules) → **Publicar**.
   > ⚠️ Si este proyecto de Firebase ya lo usa otra aplicación con sus propias reglas, **no las sustituyas**:
   > añade solo el bloque `match /sessions/{sid} { ... }` dentro del `match /databases/{database}/documents { ... }` existente.
4. **Dominio autorizado**: **Authentication → Configuración → Dominios autorizados** → añade el dominio de Vercel
   (p. ej. `tu-proyecto.vercel.app`).

La configuración web ya está en `public/config.js`.

### 2. Desplegar en Vercel

1. En <https://vercel.com> → **Add New → Project** → importa este repositorio de GitHub.
2. Framework Preset: **Other**. Sin comando de build (el `vercel.json` ya indica la carpeta `public`).
3. **Deploy**. Obtendrás un enlace del tipo `https://tu-proyecto.vercel.app`.

### 3. Usarlo en la presentación

- **Presentador** (ordenador + proyector): abre `https://tu-proyecto.vercel.app/presentador`.
  Se crea una sesión y aparece el QR (`https://tu-proyecto.vercel.app/?s=xxxxxx`).
- **Participantes**: escanean el QR, escriben un apodo y siguen las instrucciones en el móvil.
- Usa siempre **el mismo navegador** para el panel: la sesión queda asociada a él (si recargas la página, sigue la misma).
- Antes de empezar, pulsa **Reiniciar** para borrar los participantes de las pruebas.

**Comprobación rápida**: abre `/presentador` en el ordenador y el QR con tu móvil; si tu apodo aparece en la
pantalla, todo está bien configurado. Si el panel muestra «No se pudo conectar con Firebase», revisa los pasos 1–3.

---

## Opción B — Servidor local (plan B, sin Firebase)

Requiere [Node.js](https://nodejs.org) 18 o superior. Sin dependencias que instalar.

1. Cambia a `window.BASS_FIREBASE = null;` en `public/config.js`.
2. Ejecuta `node server.js` (o doble clic en `iniciar.bat`).
3. Se abre automáticamente el panel del presentador
   (`http://localhost:3000/presentador?key=...`; la clave evita que otros controlen el juego).
4. Los móviles acceden por:
   - **Misma red Wi-Fi**: el QR usa la IP local del ordenador (p. ej. `http://192.168.1.39:3000`).
     Algunas redes universitarias bloquean la comunicación entre dispositivos; en ese caso usa la opción siguiente.
   - **Túnel público gratuito** (Cloudflare, sin cuenta): instala `cloudflared`
     (`winget install --id Cloudflare.cloudflared`) y vuelve a ejecutar `node server.js`.
     El servidor crea el túnel automáticamente y el QR pasa a usar el enlace `https://….trycloudflare.com`.

Variables opcionales: `PORT` (puerto), `PUBLIC_URL` (forzar la URL del QR), `NO_TUNNEL=1`, `NO_OPEN=1`.

---

## Referencias

- Bass, F. M. (1969). A New Product Growth for Model Consumer Durables. *Management Science*, 15(5), 215–227.
- Sultan, F., Farley, J. U. y Lehmann, D. R. (1990). A Meta-Analysis of Applications of Diffusion Models.
  *Journal of Marketing Research*, 27(1), 70–77. (Valores medios de referencia: p ≈ 0,03; q ≈ 0,38.)
