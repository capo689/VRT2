// CLAW VRT2 — Shared configuration constants
// Single source of truth for values used across multiple files.
// Import with: const { PORT } = require('./lib/config');   (from project root)
//          or: const { PORT } = require('../lib/config');  (from jobs/ subdirectory)
//
// NOTE: dashboard_vrt2.html has a display-only text reference to the port
// that still requires manual update if port changes. It is left hardcoded
// because wiring it dynamically would require a /config endpoint.
// Source of truth remains this file.

module.exports = {
  PORT: 51752,
};
