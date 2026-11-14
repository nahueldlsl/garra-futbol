name: Reporte de bug
description: Reportá un error en la simulación, gráficos, audio o controles.
title: "[Bug]: "
labels: ["bug"]
body:
  - type: textarea
    id: description
    attributes:
      label: Descripción del problema
      description: Explicá qué ocurrió y qué esperabas que sucediera.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Pasos para reproducir
      placeholder: |
        1. Ir a...
        2. Presionar...
        3. Observar...
    validations:
      required: true
  - type: input
    id: environment
    attributes:
      label: Navegador y sistema operativo
      placeholder: Ej. Chrome 130 en macOS / Firefox en Windows
    validations:
      required: false
