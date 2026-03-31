# Public API Contracts

This directory publishes the frontend-visible API contracts that the extension depends on.

Goals:

- document the minimum request and response shapes required by the frontend
- version the contracts independently from implementation details
- give contributors fixtures/schemas they can review without private backend access

Scope:

- these schemas are intentionally conservative and describe the stable subset consumed by the frontend
- fields not used by the frontend may still exist on the backend
- unless noted otherwise, backend responses should use one of these envelopes:
  - success: `{ "data": { ... } }`
  - error: `{ "error": { "code": string, "message": string, "details"?: object } }`

Versioning:

- current published contract set: `v1`
- additive backend fields are allowed unless a schema says `additionalProperties: false`

Published coverage:

- auth login
- ping
- config
- limits
- recipient sources
- recipient source recipients
- analyze enqueue request
- followings enqueue request
- send enqueue request
- send pull request/response
- send result request
- send heartbeat request
- send websocket events
- jobs websocket events

Examples:

- `contracts/v1/examples/` contains anonymized request/response and event samples
- each example references its source schema through the `schema` field

Known gaps:

- no backend-generated example payloads yet
- debug endpoints are not published yet
