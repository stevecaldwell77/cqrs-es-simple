const test = require('ava');
const shortid = require('shortid');
const uuid = require('uuid/v4');
const sinon = require('sinon');
const EventRepository = require('hebo-event-repository-inmemory');
const SnapshotRepository = require('hebo-snapshot-repository-inmemory');
const NotificationHandler = require('hebo-notification-handler-inmemory');
const { UnauthorizedError } = require('hebo-validation');
const libraryAggregate = require('./helpers/aggregates/library');
const { users, getAuthorizer } = require('./helpers/authorizer');
const Hebo = require('..');

const hebo = new Hebo({
    aggregates: {
        library: libraryAggregate,
    },
});

const getEventRepository = () =>
    new EventRepository({ aggregates: ['library'] });

const getEmptySnapshotRepository = () =>
    new SnapshotRepository({ aggregates: ['library'] });

const setupBasicLibrary = async (name, city) => {
    const libraryId = shortid.generate();
    const eventRepository = getEventRepository();
    await eventRepository.writeEvent({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'NAME_SET',
        payload: { name },
        metadata: {
            user: users.superSally,
        },
        sequenceNumber: 1,
    });
    await eventRepository.writeEvent({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'CITY_NAME_SET',
        payload: { name: city },
        metadata: {
            user: users.superSally,
        },
        sequenceNumber: 2,
    });
    return { libraryId, eventRepository };
};

const runGetProjection = async ({
    aggregateName,
    aggregateId,
    eventRepository,
    snapshotRepository,
    authorizer,
    user = users.superSally,
    opts,
}) => {
    const notificationHandler = new NotificationHandler();
    const { getProjection, updateSnapshot } = hebo.connect({
        eventRepository,
        snapshotRepository,
        notificationHandler,
        authorizer,
        user,
    });
    const getSnapshotSpy = sinon.spy(snapshotRepository, 'getSnapshot');
    const getEventsSpy = sinon.spy(eventRepository, 'getEvents');
    const projection = await getProjection(aggregateName, aggregateId, opts);
    const getSnapshotCalls = getSnapshotSpy.getCalls().map(c => c.args);
    const getEventsCalls = getEventsSpy.getCalls().map(c => c.args);
    getSnapshotSpy.restore();
    getEventsSpy.restore();
    return {
        projection,
        getSnapshotCalls,
        getEventsCalls,
        notifications: notificationHandler.getNotifications(),
        updateSnapshot,
    };
};

/*

Setup a repository with some invalid events that theoretically should not have
been allowed into the event store. But maybe they were valid at the time, and
our rules changed later.

Will add the following events:

  * invalid: missing a name in the payload
  * invalid: library doesn't have any books yet.
  * Valid (sets libary name)
  * invalid: missing metadata. (maybe from bug in the event repository implementation)

*/
const setupInvalidEventRepository = async () => {
    const { libraryId, eventRepository } = await setupBasicLibrary(
        'North Branch',
        'Los Angeles',
    );

    const invalidEvent1 = {
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'CITY_NAME_SET',
        payload: {},
        metadata: {
            user: users.superSally,
        },
        sequenceNumber: 3,
    };
    await eventRepository.writeEvent(invalidEvent1);

    const invalidEvent2 = {
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'ACTIVATED',
        payload: {},
        metadata: {
            user: users.superSally,
        },
        sequenceNumber: 4,
    };
    await eventRepository.writeEvent(invalidEvent2);

    await eventRepository.writeEvent({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'NAME_SET',
        payload: { name: 'Rodgers Branch' },
        metadata: {
            user: users.superSally,
        },
        sequenceNumber: 5,
    });

    const invalidEvent3 = {
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'CITY_NAME_SET',
        payload: {
            name: 'Playa Vista',
        },
        sequenceNumber: 6,
    };
    await eventRepository.forceWriteEvent(invalidEvent3);

    const invalidEvents = [invalidEvent1, invalidEvent2, invalidEvent3];
    return { libraryId, eventRepository, invalidEvents };
};

const testGetProjection = async ({
    t,
    label,
    aggregateName,
    aggregateId,
    eventRepository,
    snapshotRepository,
    authorizer,
    user,
    expectedProjection,
    expectedGetSnapshotCalls,
    expectedGetEventsCalls,
    expectedNotifications,
}) => {
    const {
        projection,
        notifications,
        getSnapshotCalls,
        getEventsCalls,
        updateSnapshot,
    } = await runGetProjection({
        aggregateName,
        aggregateId,
        eventRepository,
        snapshotRepository,
        authorizer,
        user,
    });

    t.deepEqual(
        projection,
        expectedProjection,
        `${label}: correct projection returned`,
    );

    t.deepEqual(
        getSnapshotCalls,
        expectedGetSnapshotCalls,
        `${label}: getSnapshot() called as expected`,
    );

    t.deepEqual(
        getEventsCalls,
        expectedGetEventsCalls,
        `${label}: getEvents() called as expected`,
    );

    t.deepEqual(
        notifications,
        expectedNotifications,
        `${label}: expected notifications`,
    );

    return { updateSnapshot };
};

// Calling getProjection() for an aggregate that has no events
test('aggregate does not exist', async t => {
    const libraryId = shortid.generate();
    const authorizer = getAuthorizer(libraryId);
    const { projection, notifications } = await runGetProjection({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository: getEventRepository(),
        snapshotRepository: getEmptySnapshotRepository(),
        authorizer,
    });
    t.is(projection, undefined, 'returns undefined for unknown aggregate id');
    t.deepEqual(notifications, [], 'no notifications');
});

// Calling getProjection() for an aggregate that has no events, but we want a
// new projection to be returned.
test('aggregate does not exist, missValue = "newProjection"', async t => {
    const libraryId = shortid.generate();
    const authorizer = getAuthorizer(libraryId);
    const { projection } = await runGetProjection({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository: getEventRepository(),
        snapshotRepository: getEmptySnapshotRepository(),
        authorizer,
        opts: { missValue: 'newProjection' },
    });
    t.deepEqual(
        projection,
        {
            state: {
                libraryId,
                libraryName: null,
                cityName: null,
                active: false,
                books: [],
            },
            version: 0,
            invalidEvents: [],
            ignoredEvents: [],
        },
        'returns initialized projection',
    );
});

// Calling getProjection() for an aggregate that has no snapshot, but has events
test('aggregate with no snapshot', async t => {
    const { libraryId, eventRepository } = await setupBasicLibrary(
        'North Branch',
        'Los Angeles',
    );
    const snapshotRepository = getEmptySnapshotRepository();
    const authorizer = getAuthorizer(libraryId);

    await testGetProjection({
        t,
        label: 'no snaphot',
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository,
        snapshotRepository,
        authorizer,
        expectedProjection: {
            state: {
                libraryId,
                libraryName: 'North Branch',
                cityName: 'Los Angeles',
                active: false,
                books: [],
            },
            version: 2,
            invalidEvents: [],
            ignoredEvents: [],
        },
        expectedGetSnapshotCalls: [['library', libraryId]],
        expectedGetEventsCalls: [['library', libraryId, 0]],
        expectedNotifications: [],
    });
});

// Test calling getProjection() with snapshots, both latest and outdated
test('aggregate with snapshots', async t => {
    const { libraryId, eventRepository } = await setupBasicLibrary(
        'North Branch',
        'Los Angeles',
    );
    const snapshotRepository = getEmptySnapshotRepository();
    const authorizer = getAuthorizer(libraryId);

    // Save snapshot with basic library (which is version 2)
    const { updateSnapshot } = await runGetProjection({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository,
        snapshotRepository,
        authorizer,
    });
    await updateSnapshot('library', libraryId);

    // OK, now our snapshot repo has a projection at version 2
    // Test that calling getProjection() works again, but uses snapshot.
    await testGetProjection({
        t,
        label: 'up-to-date snaphot',
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository,
        snapshotRepository,
        authorizer,
        expectedProjection: {
            state: {
                libraryId,
                libraryName: 'North Branch',
                cityName: 'Los Angeles',
                active: false,
                books: [],
            },
            version: 2,
            invalidEvents: [],
            ignoredEvents: [],
        },
        expectedGetSnapshotCalls: [['library', libraryId]],
        expectedGetEventsCalls: [['library', libraryId, 2]],
        expectedNotifications: [],
    });

    // Now add one more event, and make sure everything still works correctly.
    await eventRepository.writeEvent({
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'CITY_NAME_SET',
        payload: { name: 'Playa Del Rey' },
        metadata: {
            user: users.superSally,
        },
        sequenceNumber: 3,
    });

    await testGetProjection({
        t,
        label: 'out-of-date snaphot',
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository,
        snapshotRepository,
        authorizer,
        expectedProjection: {
            state: {
                libraryId,
                libraryName: 'North Branch',
                cityName: 'Playa Del Rey', // this was updated
                active: false,
                books: [],
            },
            version: 3, // this was updated
            invalidEvents: [],
            ignoredEvents: [],
        },
        expectedGetSnapshotCalls: [['library', libraryId]],
        expectedGetEventsCalls: [['library', libraryId, 2]],
        expectedNotifications: [],
    });
});

// Test calling getProjection() with a event store that has a bad event
test('handing bad events', async t => {
    const {
        libraryId,
        eventRepository,
        invalidEvents,
    } = await setupInvalidEventRepository();
    const snapshotRepository = getEmptySnapshotRepository();
    const authorizer = getAuthorizer(libraryId);

    const [invalidEvent1, invalidEvent2, invalidEvent3] = invalidEvents;

    // Expected:
    //  * The bad events are stored to invalidEvents
    //  * The bad events should not have affected the state
    //  * The later good event is still applied to the state
    //  * The projection version should have been incremented
    //  * We get a notification about the invalid events.
    const { updateSnapshot } = await testGetProjection({
        t,
        label: 'unhandled bad events',
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository,
        snapshotRepository,
        authorizer,
        expectedProjection: {
            state: {
                libraryId,
                libraryName: 'Rodgers Branch', // this was updated by event 5
                cityName: 'Los Angeles',
                active: false,
                books: [],
            },
            version: 6, // this was updated to the last event
            invalidEvents: [
                {
                    eventId: invalidEvent1.eventId,
                    error: {
                        name: 'EventPayloadError',
                        message: 'event payload missing "name"',
                    },
                },
                {
                    eventId: invalidEvent2.eventId,
                    error: {
                        name: 'InvariantViolatedError',
                        message: 'An active library must have at least 1 book',
                    },
                },
                {
                    eventId: invalidEvent3.eventId,
                    error: {
                        name: 'InvalidEventError',
                        message: '"metadata" is required',
                    },
                },
            ],
            ignoredEvents: [],
        },
        expectedGetSnapshotCalls: [['library', libraryId]],
        expectedGetEventsCalls: [['library', libraryId, 0]],
        expectedNotifications: [
            {
                name: 'invalidEventsFound',
                notification: {
                    aggregateName: 'library',
                    aggregateId: libraryId,
                    eventIds: [
                        invalidEvent1.eventId,
                        invalidEvent2.eventId,
                        invalidEvent3.eventId,
                    ],
                },
            },
        ],
    });

    // Snapshot our projection, to make sure that invalid events are retrieved
    // correctly below.
    await updateSnapshot('library', libraryId);

    // Now create 2 events that resolve the 3 issues.
    const resolvingEvent1 = {
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'CITY_NAME_SET',
        payload: {
            name: 'Playa Vista',
        },
        metadata: {
            user: users.superSally,
            resolvesEventIds: [invalidEvent1.eventId, invalidEvent3.eventId],
        },
        sequenceNumber: 7,
    };
    await eventRepository.writeEvent(resolvingEvent1);

    const resolvingEvent2 = {
        aggregateName: 'library',
        aggregateId: libraryId,
        eventId: uuid(),
        type: 'DEACTIVATED',
        payload: {},
        metadata: {
            user: users.superSally,
            resolvesEventIds: [invalidEvent2.eventId],
        },
        sequenceNumber: 8,
    };
    await eventRepository.writeEvent(resolvingEvent2);

    // Expected:
    //  * The new events are applied
    //  * The bad events are moved to ignoredEvents
    //  * No notifications generated.
    await testGetProjection({
        t,
        label: 'bad events resolved',
        aggregateName: 'library',
        aggregateId: libraryId,
        eventRepository,
        snapshotRepository,
        authorizer,
        expectedProjection: {
            state: {
                libraryId,
                libraryName: 'Rodgers Branch',
                cityName: 'Playa Vista',
                active: false,
                books: [],
            },
            version: 8,
            invalidEvents: [],
            ignoredEvents: [
                {
                    eventId: invalidEvent1.eventId,
                    resolvingEventId: resolvingEvent1.eventId,
                },
                {
                    eventId: invalidEvent3.eventId,
                    resolvingEventId: resolvingEvent1.eventId,
                },
                {
                    eventId: invalidEvent2.eventId,
                    resolvingEventId: resolvingEvent2.eventId,
                },
            ],
        },
        expectedGetSnapshotCalls: [['library', libraryId]],
        expectedGetEventsCalls: [['library', libraryId, 6]],
        expectedNotifications: [],
    });
});

// Test calling getProjection() with a event store that has a bad event, but
// with throwOnInvalidEvent set to true
test('handing bad events - w/ throwOnInvalidEvent', async t => {
    const { libraryId, eventRepository } = await setupInvalidEventRepository();
    const snapshotRepository = getEmptySnapshotRepository();
    const notificationHandler = new NotificationHandler();
    const authorizer = getAuthorizer(libraryId);

    const hebo = new Hebo({
        aggregates: {
            library: libraryAggregate,
        },
        throwOnInvalidEvent: true,
    });

    const { getProjection } = hebo.connect({
        eventRepository,
        snapshotRepository,
        notificationHandler,
        authorizer,
        user: users.superSally,
    });

    await t.throwsAsync(
        getProjection('library', libraryId),
        /event payload missing "name"/,
        'error thrown when invalid event fetched from repository and throwOnInvalidEvent is true',
    );
});

test('authorization', async t => {
    const libraryId1 = shortid.generate();
    const libraryId2 = shortid.generate();
    const eventRepository = getEventRepository();
    const snapshotRepository = getEmptySnapshotRepository();
    const authorizer = getAuthorizer(libraryId1);

    const run = (libraryId, user) =>
        runGetProjection({
            aggregateName: 'library',
            aggregateId: libraryId,
            eventRepository,
            snapshotRepository,
            authorizer,
            user,
        });

    await t.notThrowsAsync(
        run(libraryId1, users.superSally),
        'superuser able to run getProjection() on first library',
    );

    await t.notThrowsAsync(
        run(libraryId1, users.marySmith),
        'read-all user is able to run getProjection() on first library',
    );

    await t.notThrowsAsync(
        run(libraryId1, users.johnDoe),
        'library-specific user is able to run getProjection() on first library',
    );

    await t.notThrowsAsync(
        run(libraryId2, users.superSally),
        'superuser able to run getProjection() on second library',
    );

    await t.notThrowsAsync(
        run(libraryId2, users.marySmith),
        'read-all user is able to run getProjection() on second library',
    );

    await t.throwsAsync(
        run(libraryId2, users.johnDoe),
        UnauthorizedError,
        'error thrown when library-specific user runs getProjection() on a ' +
            'different library',
    );
});
