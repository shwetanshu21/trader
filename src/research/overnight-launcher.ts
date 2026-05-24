// ── OvernightProcessLauncher ──
// Concrete OvernightTriggerLauncher that spawns the overnight research CLI
// as an independent child process. Uses detached spawn so the research run
// continues even if the scheduler tick moves on.

import { spawn } from 'node:child_process';
import type { OvernightTriggerLauncher, OvernightTriggerLaunchInput } from './overnight-trigger.js';

export interface OvernightProcessLauncherOptions {
  /** Absolute or relative path to the overnight-research-main.ts entrypoint. */
  scriptPath: string;
  /** Path to the main SQLite DB (overnight run state). */
  dbPath: string;
  /** Path to the research SQLite DB (hypotheses, evaluations). Defaults to dbPath. */
  researchDbPath?: string;
  /** Run in simulation mode (no LLM calls). */
  simulatePhases: boolean;
  /** Simulated generation count when simulatePhases=true. */
  simulateGenCount?: number;
  /** Simulated evaluation count when simulatePhases=true. */
  simulateEvalCount?: number;
  /** Max accepted candidates budget cap. */
  maxAcceptedCandidates?: number;
  /** Max LLM call budget cap. */
  maxLlmCalls?: number;
}

export class OvernightProcessLauncher implements OvernightTriggerLauncher {
  private readonly _options: OvernightProcessLauncherOptions;

  constructor(options: OvernightProcessLauncherOptions) {
    this._options = options;
  }

  async launch(input: OvernightTriggerLaunchInput): Promise<void> {
    const args = this._buildArgs(input);

    console.log(
      `[overnight-launcher] Spawning research run ${input.runId} → ${input.workspacePath}`,
    );

    return new Promise((resolve, reject) => {
      const child = spawn('npx', ['tsx', this._options.scriptPath, ...args], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      child.on('error', (err) => {
        console.error(
          `[overnight-launcher] Spawn error for run ${input.runId}: ${err.message}`,
        );
        reject(err);
      });

      // Unref immediately so the scheduler does not wait for the long-running child.
      child.unref();

      // Resolve as soon as the process starts; we do not wait for completion.
      // The orchestrator tracks run state via the DB, not via process exit.
      resolve();
    });
  }

  private _buildArgs(input: OvernightTriggerLaunchInput): string[] {
    const args: string[] = [
      '--db-path', this._options.dbPath,
      '--workspace-path', input.workspacePath,
      '--label', input.label,
    ];

    const researchDb = this._options.researchDbPath ?? this._options.dbPath;
    args.push('--research-db-path', researchDb);

    if (this._options.simulatePhases) {
      args.push('--simulate-phases');
      args.push('--simulate-gen-count', String(this._options.simulateGenCount ?? 3));
      args.push('--simulate-eval-count', String(this._options.simulateEvalCount ?? 5));
    } else {
      args.push('--simulate-phases', 'false');
    }

    if (this._options.maxAcceptedCandidates != null) {
      args.push('--max-accepted-candidates', String(this._options.maxAcceptedCandidates));
    }

    if (this._options.maxLlmCalls != null) {
      args.push('--max-llm-calls', String(this._options.maxLlmCalls));
    }

    return args;
  }
}
