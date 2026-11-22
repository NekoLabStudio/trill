// This service's version (set by support/prepare-release.sh at each release) and its protocol
// number, which goes up when a change means older clients can't talk to it, or clients need a
// newer service. Clients check the protocol on every response (X-Trill-Protocol).
export const SERVICE_VERSION = "0.1.0";
export const PROTOCOL = 2;
