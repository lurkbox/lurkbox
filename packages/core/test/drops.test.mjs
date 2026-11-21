import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDropsChip, dropsScreen, dropsPadKey, INVENTORY_URL } from '../src/js/drops.js';

const campaigns = [
  { game: 'Rust', name: 'Rust: Winter Drops Week', drops: [
    { name: 'Winter Jacket', percent: 45, claimable: false },
    { name: 'Frost Hatchet', percent: 100, claimable: true },
    { name: 'Pickaxe', percent: 70, claimable: false },
  ] },
  { game: '', name: 'Example Quest: Launch Celebration', drops: [{ name: 'Pocket Pet', percent: 10, claimable: false }] },
  { game: 'Done Game', name: 'All claimed', drops: [{ name: 'Old', percent: 100, claimable: false }] },
];

test('drops chip: the unfinished drop with the most progress for the stream\'s game', () => {
  assert.deepEqual(pickDropsChip(campaigns, 'Rust'), { name: 'Pickaxe', percent: 70, label: 'Drop 70% · Pickaxe' });
  assert.equal(pickDropsChip(campaigns, 'rust').name, 'Pickaxe'); // case
  // No game on the card: a campaign name that starts with the game.
  assert.equal(pickDropsChip(campaigns, 'Example Quest').name, 'Pocket Pet');
});

test('drops chip: nothing for other games, finished campaigns, or missing data', () => {
  assert.equal(pickDropsChip(campaigns, 'Rusty Lake'), null);
  assert.equal(pickDropsChip(campaigns, 'Example'), null);
  assert.equal(pickDropsChip([{ game: '', name: 'Rusty Lake Week', drops: [{ name: 'x', percent: 5 }] }], 'Rusty'), null);
  assert.equal(pickDropsChip(campaigns, 'Done Game'), null);
  assert.equal(pickDropsChip(campaigns, ''), null);
  assert.equal(pickDropsChip(null, 'Rust'), null);
  assert.equal(pickDropsChip([{ game: 'Rust', drops: [{ name: 'x', percent: null }] }], 'Rust'), null);
});

test('Drops section: sign-in prompt without a twitch.tv session, the inventory with one', () => {
  assert.equal(dropsScreen({ supported: false, signedIn: true }), 'unsupported');
  assert.equal(dropsScreen({ supported: true, signedIn: false }), 'signin');
  assert.equal(dropsScreen({ supported: true, signedIn: true }), 'inventory');
  assert.equal(INVENTORY_URL, 'https://www.twitch.tv/drops/inventory');
});

test('Drops section: D-pad, A and B go to the page; LB/RB, Y and the rest stay with the app', () => {
  assert.deepEqual(['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B'].map(dropsPadKey), ['up', 'down', 'left', 'right', 'a', 'b']);
  for (const a of ['LB', 'RB', 'Y', 'X', 'START']) assert.equal(dropsPadKey(a), null);
});
