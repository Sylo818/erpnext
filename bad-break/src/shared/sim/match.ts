/**
 * Match rules. Rounds: intro -> fight -> ending -> intermission -> (next round | over).
 * Both fighters' outcomes are resolved before a winner is declared for a tick. Fatal trauma ends a
 * fighter's round immediately; a knockout ends it once the knockout count completes; blackouts are
 * recoverable and never end the round by themselves.
 */
import type { MatchSettings } from "../config.js";
import { DEFAULT_MATCH } from "../config.js";
import type { SimWorld } from "./world.js";
import { emptyIntent, type Intent } from "./input.js";

export type Phase = "intro" | "fight" | "ending" | "intermission" | "over";
export type Outcome = "ok" | "knockout" | "dead";
export interface RoundSummary {
  round: number;
  winner: 0 | 1 | "draw";
  reason: string;
  /** Short human readable cause for the loser (for the results screen). */
  cause: string;
  seconds: number;
  vitality: [number, number];
}

export class MatchSystem {
  phase: Phase = "intro";
  round = 1;
  scores: [number, number] = [0, 0];
  timeLeft: number;
  phaseT = 0;
  lastSummary: RoundSummary | null = null;
  history: RoundSummary[] = [];
  winner: 0 | 1 | "draw" | null = null;
  settings: MatchSettings;
  /** Presentation hint (slow motion at the end of a round). The sim clock itself is never scaled. */
  presentationScale = 1;
  introSeconds = 2.2;
  private roundStartTime = 0;
  drawsInARow = 0;
  /** Seconds each fighter has been in the current knockout count. */
  koClock: [number, number] = [0, 0];

  constructor(private world: SimWorld, settings?: Partial<MatchSettings>) {
    this.settings = { ...DEFAULT_MATCH, ...settings };
    this.timeLeft = this.settings.roundSeconds;
  }

  begin() {
    this.phase = "intro";
    this.phaseT = 0;
    this.timeLeft = this.settings.roundSeconds;
    this.world.emit({ t: "roundStart", round: this.round });
  }

  /** Masks inputs by phase: nobody fights during intro/ending. */
  gate(i: Intent, slot: number): Intent {
    if (this.phase === "fight" || (this.phase === "ending" && false)) return i;
    if (this.phase === "ending" || this.phase === "intermission" || this.phase === "over") {
      // the winner may keep moving a little; everyone else is idle. Taunts disabled.
      const e = emptyIntent();
      e.seq = i.seq;
      e.aimYaw = i.aimYaw;
      return e;
    }
    const e = emptyIntent();
    e.seq = i.seq;
    e.aimYaw = i.aimYaw;
    return e;
  }

  outcomeOf(slot: number): Outcome {
    const f = this.world.fighters[slot];
    if (f.inj.consciousness === "dead") return "dead";
    if (f.inj.consciousness === "knockout" && this.koClock[slot] >= this.settings.knockoutCountSeconds) return "knockout";
    return "ok";
  }

  step(dt: number) {
    const w = this.world;
    this.phaseT += dt;
    switch (this.phase) {
      case "intro": {
        if (this.phaseT >= this.introSeconds) {
          this.phase = "fight";
          this.phaseT = 0;
          this.roundStartTime = w.time;
        }
        break;
      }
      case "fight": {
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        for (let s = 0; s < 2; s++) {
          const f = w.fighters[s];
          this.koClock[s] = f.inj.consciousness === "knockout" ? this.koClock[s] + dt : 0;
        }
        // resolve BOTH outcomes before declaring anything
        const o0 = this.outcomeOf(0);
        const o1 = this.outcomeOf(1);
        if (o0 !== "ok" || o1 !== "ok") {
          if (o0 !== "ok" && o1 !== "ok") this.finishRound("draw", o0 === "dead" || o1 === "dead" ? "double fatality" : "double knockout");
          else if (o0 !== "ok") this.finishRound(1, o0 === "dead" ? "fatal trauma" : "knockout");
          else this.finishRound(0, o1 === "dead" ? "fatal trauma" : "knockout");
        } else if (this.timeLeft <= 0) {
          const v0 = w.fighters[0].inj.vitality;
          const v1 = w.fighters[1].inj.vitality;
          if (Math.abs(v0 - v1) < 1e-6) this.finishRound("draw", "time limit tie");
          else this.finishRound(v0 > v1 ? 0 : 1, "time limit");
        }
        break;
      }
      case "ending": {
        // dramatic slow motion at the very start of the ending, relaxing back to normal
        this.presentationScale = this.phaseT < 1.6 ? 0.3 + 0.7 * (this.phaseT / 1.6) : 1;
        if (this.phaseT >= 3.4) {
          this.phase = "intermission";
          this.phaseT = 0;
          this.presentationScale = 1;
        }
        break;
      }
      case "intermission": {
        if (this.phaseT >= 0.6) {
          if (this.scores[0] >= this.settings.roundsToWin) this.overMatch(0);
          else if (this.scores[1] >= this.settings.roundsToWin) this.overMatch(1);
          else if (this.round >= 9) this.overMatch(this.scores[0] === this.scores[1] ? "draw" : this.scores[0] > this.scores[1] ? 0 : 1);
          else this.nextRound();
        }
        break;
      }
      case "over":
        break;
    }
  }

  private finishRound(winner: 0 | 1 | "draw", reason: string) {
    const w = this.world;
    this.phase = "ending";
    this.phaseT = 0;
    const loser = winner === "draw" ? -1 : 1 - winner;
    let cause = "";
    if (winner === "draw") cause = "mutual stupidity";
    else {
      const lf = w.fighters[loser];
      cause = lf.inj.deathCause ?? lf.inj.lastCause ?? reason;
    }
    const sum: RoundSummary = { round: this.round, winner, reason, cause, seconds: this.settings.roundSeconds - this.timeLeft, vitality: [w.fighters[0].inj.vitality, w.fighters[1].inj.vitality] };
    this.lastSummary = sum;
    this.history.push(sum);
    if (winner === "draw") this.drawsInARow++;
    else {
      this.drawsInARow = 0;
      this.scores[winner]++;
      w.fighters[winner].setState("celebrate");
      w.fighters[winner].celebrateT = 0;
      w.fighters[winner].celebrateKind = this.round;
    }
    this.winner = winner;
    w.emit({ t: "roundEnd", round: this.round, winner, reason });
  }

  private overMatch(winner: 0 | 1 | "draw") {
    this.phase = "over";
    this.phaseT = 0;
    this.winner = winner;
    this.world.emit({ t: "matchEnd", winner, scores: [...this.scores] as [number, number] });
  }

  private nextRound() {
    // draws replay the same round number
    if (this.lastSummary && this.lastSummary.winner !== "draw") this.round++;
    this.koClock = [0, 0];
    this.world.resetRound();
    this.begin();
  }

  /** Fast rematch: same fighters and settings, scores reset. */
  rematch() {
    this.scores = [0, 0];
    this.round = 1;
    this.history = [];
    this.winner = null;
    this.lastSummary = null;
    this.drawsInARow = 0;
    this.koClock = [0, 0];
    this.presentationScale = 1;
    this.world.resetRound();
    this.begin();
  }

  get fightSeconds(): number {
    return this.world.time - this.roundStartTime;
  }
}
