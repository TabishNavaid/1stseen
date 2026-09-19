/**
 * Keep every Request and Response clone reachable for the life of a Node test process.
 *
 * These tests run the built Worker in Node. Node 22.14.0 bundles undici 6.21.1, whose
 * `cloneBody` registers the new clone for garbage collection against the ORIGINAL body stream,
 * so collecting an unused clone cancels the original body. vinext clones every request that
 * has a body before running middleware, then builds the route handler's request from the
 * original; a collection between the two throws "Response body object should not be disturbed
 * or locked". Forcing a collection at that point fails 50 of 50 times and never fails without
 * one; under 12-way parallel test load, 32 of 41 body-sending runs failed.
 *
 * Production runs on workerd, and `vinext dev` runs the Worker in workerd through the
 * Cloudflare Vite plugin; neither uses undici. Retaining clones changes no route behaviour: the
 * route reads the same body it would have read.
 */
const retained = new Set();

for (const Type of [Request, Response]) {
  const clone = Type.prototype.clone;
  if (clone.retainsClones) continue;
  const retainedClone = function retainedClone() {
    const copy = clone.call(this);
    retained.add(copy);
    return copy;
  };
  retainedClone.retainsClones = true;
  Type.prototype.clone = retainedClone;
}
