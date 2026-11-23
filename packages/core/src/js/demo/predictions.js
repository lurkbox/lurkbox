// Demo mode's predictions and polls (desktop LURKBOX_DEMO_PREDICTIONS=1): web GQL answers for ppQuery() made up in
// memory, so the host's real PredictionsWatcher and the player's card run without the network. Every live channel has
// a two-outcome prediction and a three-choice poll that started a minute before the demo clock; the totals grow with
// each answer, a bet or vote lands in them (and in "self"), and the prediction locks when its window ends.
// Pure; used by apps/desktop/src/main/demo.js.

const OUTCOMES = [['Yes, first try', 'BLUE', 42000, 31], ['No way', 'PINK', 18500, 17]];
const CHOICES = [['Forest level', 41], ['Lava level', 23], ['Ice level', 12]];

export function createDemoPredictions({ now }) {
  const channels = new Map();
  const at = () => now();
  const channel = (login) => {
    if (!channels.has(login)) {
      const t0 = at() - 60000;
      channels.set(login, {
        prediction: {
          id: `demo-pred-${login}`, title: 'Does the boss go down this run?', status: 'ACTIVE', createdAt: new Date(t0).toISOString(),
          predictionWindowSeconds: 300, lockedAt: null, endedAt: null, winningOutcome: null,
          outcomes: OUTCOMES.map(([title, color, points, users], i) => ({ id: `demo-out-${login}-${i}`, title, color, totalPoints: points, totalUsers: users })),
          self: null,
        },
        poll: { id: `demo-poll-${login}`, title: 'Which level next?', status: 'ACTIVE', durationSeconds: 180, startedAt: new Date(t0).toISOString(), endsAt: t0 + 180000, endedAt: null,
          choices: CHOICES.map(([title, votes], i) => ({ id: `demo-choice-${login}-${i}`, title, votes: { total: votes, base: votes, communityPoints: 0, bits: 0 } })),
          settings: { communityPointsVotes: { isEnabled: true, cost: 100 }, multichoice: { isEnabled: false } } },
        tick: 0,
      });
    }
    return channels.get(login);
  };
  const advance = (c) => {
    c.tick++;
    const p = c.prediction;
    if (p.status === 'ACTIVE') {
      if (at() >= Date.parse(p.createdAt) + p.predictionWindowSeconds * 1000) { p.status = 'LOCKED'; p.lockedAt = new Date(at()).toISOString(); }
      else { p.outcomes[c.tick % 2].totalPoints += 250 * (1 + (c.tick % 3)); p.outcomes[c.tick % 2].totalUsers += c.tick % 4 === 0 ? 1 : 0; }
    }
    const q = c.poll;
    if (q.status === 'ACTIVE') {
      if (at() >= q.endsAt) { q.status = 'COMPLETED'; q.endedAt = new Date(at()).toISOString(); }
      else if (c.tick % 2 === 0) { const ch = q.choices[c.tick % 3]; ch.votes.total++; ch.votes.base++; }
    }
  };
  return {
    /** The GQL answer for ppBody(login). */
    answer(login) {
      const c = channel(String(login).toLowerCase());
      advance(c);
      const q = c.poll;
      return {
        data: {
          channel: { id: '1', activePredictionEvents: c.prediction.status === 'ACTIVE' ? [c.prediction] : [], lockedPredictionEvents: c.prediction.status === 'LOCKED' ? [c.prediction] : [], resolvedPredictionEvents: { edges: [] } },
          user: { viewablePoll: { ...q, remainingDurationMilliseconds: Math.max(0, q.endsAt - at()), votes: { total: q.choices.reduce((s, x) => s + x.votes.total, 0), base: 0, communityPoints: 0, bits: 0 } } },
        },
      };
    },
    /** A bet, as Twitch's page would take it: adds to the outcome and to "self" (never switches outcome). */
    bet(login, outcomeId, points) {
      const p = channel(String(login).toLowerCase()).prediction;
      const o = p.outcomes.find((x) => x.id === outcomeId);
      if (!o || p.status !== 'ACTIVE') return { ok: false, reason: 'closed' };
      if (p.self && p.self.prediction.outcome.id !== outcomeId) return { ok: false, reason: 'you predicted another outcome' };
      o.totalPoints += points;
      if (!p.self) o.totalUsers++;
      p.self = { prediction: { id: 'demo-self', points: (p.self ? p.self.prediction.points : 0) + points, outcome: { id: outcomeId }, result: null } };
      return { ok: true };
    },
    vote(login, choiceId, withPoints) {
      const q = channel(String(login).toLowerCase()).poll;
      const ch = q.choices.find((x) => x.id === choiceId);
      if (!ch || q.status !== 'ACTIVE') return { ok: false, reason: 'closed' };
      ch.votes.total++;
      if (withPoints) ch.votes.communityPoints++; else ch.votes.base++;
      return { ok: true };
    },
  };
}
