# Guia para contribuir

Gracias por aportar al proyecto.

## Preparacion local

```bash
npm ci
npm run lint
npm run format:check
npm run test
```

## Reglas para Pull Request

- Mantener cambios pequenos y enfocados.
- No incluir credenciales, endpoints privados ni detalles de infraestructura.
- Actualizar `CHANGELOG.md` cuando haya cambios de cara al usuario.
- Verificar que CI quede en verde.

## Cambios que afectan releases

Si cambias empaquetado, instalacion o actualizacion:

- Actualiza `README.md`.
- Actualiza `RELEASE_CHECKLIST.md`.
- Documenta cambios en `RELEASE_NOTES.md`.
