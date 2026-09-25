'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  validateEdge,
  previewMemberDeletion,
} = require('../server/familyGraph');

/** 测试辅助：批量建成员（成员 id 与姓名相同） */
function makeState(names) {
  const state = createState();
  for (const name of names) {
    const member = { id: name, name };
    state.members.push(member);
    state.parentsOf[member.id] = [];
  }
  return state;
}

function add(state, parent, child) {
  const r = validateEdge(state, parent, child);
  assert.equal(r.error, null, `应允许 ${parent} -> ${child}：${r.error || ''}`);
  state.parentsOf[child].push(parent);
}

test('删除预览：移除唯一通路上的成员，祖先—后代对断联（after 为 null、成员链为空）', () => {
  // 直链 A→B→C；删除 B 后 A 与 C 不再有祖先关系
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.error, undefined);
  assert.equal(r.memberId, 'B');
  assert.equal(r.remainingMemberCount, 2);
  assert.equal(r.removedEdgeCount, 2); // A→B 与 B→C
  assert.equal(r.unchangedCount, 0);
  assert.deepEqual(r.lengthened, []);

  assert.equal(r.disconnected.length, 1);
  const item = r.disconnected[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'C');
  assert.equal(item.before.gen, 2);
  assert.deepEqual(item.before.path, ['A', 'B', 'C']);
  assert.equal(item.after, null); // 删除后不可达：成员链为空
});

test('删除预览：短链经被删成员但仍有更长替代路径——列为最短代数增加而非断联', () => {
  // A→B→D，A→C→D（两条同代 2 代路径），另建 B→C→…不对，构造如下：
  // A→B→D（2 代短链经过 B），同时 A→X→Y→D（3 代长链不经过 B）。
  const state = makeState(['A', 'B', 'D', 'X', 'Y']);
  add(state, 'A', 'B');
  add(state, 'B', 'D');
  add(state, 'A', 'X');
  add(state, 'X', 'Y');
  add(state, 'Y', 'D');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.disconnected, []); // A 仍可经 X、Y 到达 D，不是断联
  assert.equal(r.removedEdgeCount, 2);

  assert.equal(r.lengthened.length, 1);
  const item = r.lengthened[0];
  assert.equal(item.ancestorId, 'A');
  assert.equal(item.descendantId, 'D');
  assert.equal(item.before.gen, 2);
  assert.deepEqual(item.before.path, ['A', 'B', 'D']);
  assert.equal(item.after.gen, 3);
  assert.deepEqual(item.after.path, ['A', 'X', 'Y', 'D']);
});

test('删除预览：同代替代路径存在时最短代数不变，不报错、不计入变化', () => {
  // 钻石结构：A→B→D、A→C→D，两条都是 2 代；删除 B 后 A→D 改经 C，仍为 2 代。
  const state = makeState(['A', 'B', 'C', 'D']);
  add(state, 'A', 'B');
  add(state, 'A', 'C');
  add(state, 'B', 'D');
  add(state, 'C', 'D');

  const r = previewMemberDeletion(state, 'B');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.disconnected, []);
  assert.deepEqual(r.lengthened, []);
  assert.equal(r.removedEdgeCount, 2);
  // (A,C)、(A,D)、(C,D) 删除前可达且删除后最短代数不变
  assert.equal(r.unchangedCount, 3);
});

test('删除预览：断联与最短代数增加同时出现，且不涉及被删成员端点的对保持不变', () => {
  // A→M→X 是 A 到 X 的唯一路径（删除 M 后 A、X 断联）；
  // 同时 A→M→Y 为 2 代短链、A→N→Y 为 2 代同代替代（删除 M 后走 N，仍 2 代，不变）；
  // 另设 P→Q 完全不涉及 M，不受影响。
  const state = makeState(['A', 'M', 'X', 'N', 'Y', 'P', 'Q']);
  add(state, 'A', 'M');
  add(state, 'M', 'X');
  add(state, 'M', 'Y');
  add(state, 'A', 'N');
  add(state, 'N', 'Y');
  add(state, 'P', 'Q');

  const r = previewMemberDeletion(state, 'M');
  assert.equal(r.removedEdgeCount, 3); // A→M、M→X、M→Y

  // 仅 (A,X) 断联
  assert.equal(r.disconnected.length, 1);
  assert.equal(r.disconnected[0].ancestorId, 'A');
  assert.equal(r.disconnected[0].descendantId, 'X');
  assert.equal(r.disconnected[0].before.gen, 2);
  assert.deepEqual(r.disconnected[0].before.path, ['A', 'M', 'X']);
  assert.equal(r.disconnected[0].after, null);

  // 没有任何一对的最短代数变大（A→Y 改走同代替代路径 N）
  assert.deepEqual(r.lengthened, []);

  // 不受影响 / 同代替代的可达对：(A,N)、(A,Y)、(N,Y)、(P,Q)
  assert.equal(r.unchangedCount, 4);
});

test('删除预览：被删成员的多条链路一次性级联移除，各受影响后代分别报告', () => {
  // A→M，M→X，M→Y；删除 M 后 A→X、A→Y 均断联（X、Y 留在谱中但失去祖先）。
  const state = makeState(['A', 'M', 'X', 'Y']);
  add(state, 'A', 'M');
  add(state, 'M', 'X');
  add(state, 'M', 'Y');

  const r = previewMemberDeletion(state, 'M');
  assert.equal(r.remainingMemberCount, 3);
  assert.equal(r.removedEdgeCount, 3);
  assert.equal(r.disconnected.length, 2);
  assert.deepEqual(
    r.disconnected.map((i) => [i.ancestorId, i.descendantId]),
    [['A', 'X'], ['A', 'Y']],
  );
  for (const item of r.disconnected) assert.equal(item.after, null);
});

test('删除预览：孤立成员（无任何关系）不产生任何受影响成员对', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');

  const r = previewMemberDeletion(state, 'C');
  assert.equal(r.error, undefined);
  assert.equal(r.removedEdgeCount, 0);
  assert.deepEqual(r.disconnected, []);
  assert.deepEqual(r.lengthened, []);
  assert.equal(r.unchangedCount, 1); // (A,B) 仍可达且代数不变
});

test('删除预览：成员不存在时返回错误', () => {
  const state = makeState(['A']);
  const r = previewMemberDeletion(state, 'nope');
  assert.match(r.error, /成员不存在/);
  assert.equal(r.disconnected, undefined);
});

test('删除预览：纯函数构造假设图，当前家谱保持不变', () => {
  const state = makeState(['A', 'B', 'C']);
  add(state, 'A', 'B');
  add(state, 'B', 'C');
  const snapshot = JSON.stringify({ members: state.members, parentsOf: state.parentsOf });

  previewMemberDeletion(state, 'B');
  previewMemberDeletion(state, 'A');
  previewMemberDeletion(state, 'missing');

  assert.equal(
    JSON.stringify({ members: state.members, parentsOf: state.parentsOf }),
    snapshot,
    '预览不得修改当前家谱（不落盘的只读假设图）',
  );
});
