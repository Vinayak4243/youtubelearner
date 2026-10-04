const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeSnapshots } = require('../public/snapshot-merge');

test('device recovery appends new materials and assignments without replacing cloud course identity or progress', () => {
  const cloud = {
    profile:{ name:'Cloud learner' },
    courses:[{
      id:'course-1', name:'Existing course',
      sources:[{ id:'source-1', title:'Original source', lessons:[{ id:'lesson-1', title:'Lesson', done:false, concepts:['Basics'] }] }],
      assignments:[{ id:'assignment-1', submitted:false, answers:{ 0:'cloud answer' }, hints:{} }],
      concepts:{ Basics:{ name:'Basics', attempts:2, mastery:60 } },
      roadmap:[]
    }],
    events:[{ id:'event-cloud', type:'lesson_opened' }]
  };
  const local = {
    profile:{ name:'Device learner' },
    courses:[{
      id:'course-1', name:'Stale course name',
      sources:[
        { id:'source-1', title:'Original source', lessons:[{ id:'lesson-1', title:'Lesson', done:true, concepts:['Basics','Practice'] }] },
        { id:'source-2', title:'New PDF', lessons:[{ id:'lesson-2', title:'New lesson', done:false, page:4 }] }
      ],
      assignments:[
        { id:'assignment-1', submitted:false, answers:{ 1:'local answer' }, hints:{ 1:true } },
        { id:'assignment-2', submitted:false, answers:{}, hints:{} }
      ],
      concepts:{ Basics:{ name:'Basics', attempts:3, mastery:72 }, Practice:{ name:'Practice', attempts:0, mastery:35 } }
    }],
    events:[{ id:'event-local', type:'source_added' }]
  };

  const merged = mergeSnapshots(cloud, local);
  const course = merged.courses[0];
  assert.equal(course.id, 'course-1');
  assert.equal(course.name, 'Existing course');
  assert.deepEqual(course.sources.map(source => source.id), ['source-1','source-2']);
  assert.equal(course.sources[0].lessons[0].done, true);
  assert.deepEqual(course.sources[0].lessons[0].concepts, ['Basics','Practice']);
  assert.deepEqual(course.assignments[0].answers, { 0:'cloud answer', 1:'local answer' });
  assert.deepEqual(course.assignments[0].hints, { 1:true });
  assert.ok(course.assignments.some(assignment => assignment.id === 'assignment-2'));
  assert.equal(course.concepts.Basics.mastery, 72);
  assert.ok(course.concepts.Practice);
  assert.deepEqual(merged.events.map(event => event.id), ['event-cloud','event-local']);
  assert.equal(merged.profile.name, 'Cloud learner');
});
