# Guía para Contribuir

¡Gracias por tu interés en contribuir a **Garra Fútbol Web**!

## Principio clave: fidelidad 1:1

Este proyecto es una reconstrucción 1:1 del motor original de *Garra Fútbol* documentado en [SPECS.md](./SPECS.md). Cualquier cambio en física, proyección, temporizadores, reglas, IA o controles debe respetar las constantes y algoritmos especificados allí.

## Flujo de desarrollo

1. Instalá las dependencias:
   ```bash
   npm install
   ```
2. Corré el servidor local de desarrollo:
   ```bash
   npm run dev
   ```
3. Antes de abrir un Pull Request, verificá que todas las comprobaciones pasen sin errores ni advertencias:
   ```bash
   npm run check
   npm run build
   ```

## Convenciones

- **TypeScript estricto**: sin `any` implícitos ni variables/parámetros sin usar (`tsconfig.json`).
- **Estilo**: ESLint + Prettier (`npm run lint`, `npm run format:check`).
- **Tests**: agregá pruebas unitarias en `src/**/__tests__/*.test.ts` o validaciones de simulación en `src/domain/__tests__/verifySimulation.ts`.
