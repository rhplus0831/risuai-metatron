// @ts-nocheck
// Legacy file - not currently in use

/**
 * Unused Three.js/MMD loading facade with no importers. It loads rendering primitives,
 * MMDLoader, and MMDAnimationHelper for model/pose rendering.
 */

const { Scene, PerspectiveCamera, WebGLRenderer, AmbientLight, DirectionalLight } = await import("three");
const { MMDLoader } = await import("three/examples/jsm/loaders/MMDLoader");
const { MMDAnimationHelper } = await import("three/examples/jsm/animation/MMDAnimationHelper");

export { Scene, PerspectiveCamera, WebGLRenderer, AmbientLight, DirectionalLight, MMDLoader, MMDAnimationHelper };
