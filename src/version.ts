// This service's version (Purr's, set by support/prepare-release.sh at each release) and its
// protocol number, which goes up when a change means older Purr clients can't talk to it, or
// Purr clients need a newer service. Purr checks the protocol on every response.
export const SERVICE_VERSION = "0.2.1";
export const PROTOCOL = 1;
