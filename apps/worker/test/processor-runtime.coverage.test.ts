// The processor runtime owns persistence and provider/blob boundaries, so its
// contract tests intentionally exercise real PostgreSQL and local blob I/O.
// Keep the same behavioral suite in the infrastructure gate and in the root
// coverage gate so newly introduced runtime code is measured rather than
// replaced with SQL-chain mocks.
import './processor-runtime.integration.js';
