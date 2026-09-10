import { describeApp } from '@integr8/core';
import { buildAppInfo } from './app-info.js';

/**
 * Placeholder process for the desktop application.
 *
 * P01 establishes only that this workspace member builds, lints, type-checks,
 * tests and runs against the shared packages.
 * P05 replaces this with the React SPA and its Tauri v2 shell.
 */
const info = buildAppInfo();

console.log(describeApp(info));
console.log('P05 replaces this with the React SPA and its Tauri v2 shell.');
