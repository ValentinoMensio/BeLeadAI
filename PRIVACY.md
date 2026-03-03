# Aviso de privacidad (distribucion privada)

Esta extension se distribuye de forma privada para clientes autenticados.

## Datos procesados por la extension

- Configuracion de API (`api_base`) y preferencias de interfaz.
- API key en `chrome.storage.session` (solo sesion del navegador).
- Access JWT en `chrome.storage.session`.
- Sesion persistente opcional gestionada por cookies seguras del backend (`HttpOnly`, `Secure`) cuando el usuario activa "Mantener sesion iniciada".
- Identificador de cuenta de Instagram (`ds_user_id`) para ruteo de sender.
- Usernames destino y estado de tareas de envio para ejecutar el flujo.

## Uso de datos

- Los datos se usan solo para autenticar, encolar tareas, enviar mensajes y mostrar estado.
- No hay analitica oculta, trackers de terceros, fingerprinting ni keylogging.

## Comparticion de datos

- Los datos se envian solo al dominio de API configurado y autorizado por el usuario.
- No se venden ni se comparten con redes publicitarias.

## Retencion

- La API key persiste solo en la sesion activa del navegador.
- Los caches de estado de trabajos son temporales y acotados para confiabilidad operativa.

## Controles de seguridad

- La API base debe usar HTTPS.
- La autenticacion de WebSocket usa tickets efimeros (sin JWT en query string).
- La extension solicita permisos de host solo para el dominio API seleccionado.

## Responsabilidades del cliente

- Mantener credenciales del backend y accesos de tenant bajo control.
- Revocar API keys/JWT ante baja de personal o sospecha de compromiso.
- Revisar politicas de retencion y auditoria del backend.
