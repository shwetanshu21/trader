import type { TickWork } from '../runtime/scheduler.js';
import type { HealthStatus } from '../types/runtime.js';
import { OvernightRunStatus } from './overnight-run-repo.js';
import { OvernightOrchestrator } from './overnight-orchestrator.js';

export interface OvernightTriggerWindow {
  key: string;
  label: string;
  workspacePath: string;
}

export interface OvernightTriggerLaunchInput {
  runId: number;
  label: string;
  workspacePath: string;
  researchDbPath?: string;
  now: Date;
  windowKey: string;
}

export interface OvernightTriggerLauncher {
  launch(input: OvernightTriggerLaunchInput): Promise<void>;
}

export interface OvernightTriggerSupervisorOptions {
  orchestrator: OvernightOrchestrator;
  resolveWindow(now: Date): OvernightTriggerWindow;
  launcher: OvernightTriggerLauncher;
  researchDbPath?: string;
}

export interface OvernightTriggerDiagnostics {
  label: string;
  inFlight: boolean;
  lastDecisionAt: number | null;
  lastLaunchedRunId: number | null;
  duplicateSkipCount: number;
  overlapSkipCount: number;
  launchErrorCount: number;
}

export class OvernightTriggerSupervisor implements TickWork {
  readonly label = 'overnight-trigger';

  private readonly _orchestrator: OvernightOrchestrator;
  private readonly _resolveWindow: (now: Date) => OvernightTriggerWindow;
  private readonly _launcher: OvernightTriggerLauncher;
  private readonly _researchDbPath?: string;

  private _inFlight = false;
  private _lastDecisionAt: number | null = null;
  private _lastLaunchedRunId: number | null = null;
  private _duplicateSkipCount = 0;
  private _overlapSkipCount = 0;
  private _launchErrorCount = 0;

  constructor(options: OvernightTriggerSupervisorOptions) {
    this._orchestrator = options.orchestrator;
    this._resolveWindow = options.resolveWindow;
    this._launcher = options.launcher;
    this._researchDbPath = options.researchDbPath;
  }

  async doWork(now: Date, _health: HealthStatus): Promise<void> {
    this._lastDecisionAt = now.getTime();

    if (this._inFlight) {
      this._overlapSkipCount++;
      return;
    }

    const window = this._resolveWindow(now);
    const result = this._orchestrator.tryTriggerWindow({
      label: window.label,
      workspacePath: window.workspacePath,
      now,
      researchDbPath: this._researchDbPath,
    });

    if (!result.accepted) {
      return;
    }

    if (result.duplicate) {
      this._duplicateSkipCount++;
      return;
    }

    this._inFlight = true;
    this._lastLaunchedRunId = result.run.id;

    try {
      await this._launcher.launch({
        runId: result.run.id,
        label: result.run.label,
        workspacePath: result.run.workspacePath,
        researchDbPath: this._researchDbPath,
        now,
        windowKey: window.key,
      });
    } catch (error) {
      this._launchErrorCount++;
      const message = error instanceof Error ? error.message : String(error);
      const run = this._orchestrator.getRun(result.run.id);
      if (run?.status === OvernightRunStatus.Running) {
        this._orchestrator.markFailed(result.run.id, `Autonomous overnight trigger launch failed: ${message}`);
      }
      return;
    } finally {
      this._inFlight = false;
    }
  }

  getDiagnostics(): OvernightTriggerDiagnostics {
    return {
      label: this.label,
      inFlight: this._inFlight,
      lastDecisionAt: this._lastDecisionAt,
      lastLaunchedRunId: this._lastLaunchedRunId,
      duplicateSkipCount: this._duplicateSkipCount,
      overlapSkipCount: this._overlapSkipCount,
      launchErrorCount: this._launchErrorCount,
    };
  }
}
