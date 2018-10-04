const test = require('ava');
const shortid = require('shortid');
const sinon = require('sinon');
const Joi = require('joi');
const EventRepository = require('hebo-event-repository-inmemory');
const Hebo = require('..');
const {
    AggregateNotFoundError,
    DuplicateAggregateError,
    EventPayloadError,
    InvalidCommandParamsError,
    InvalidEventError,
    InvariantViolatedError,
    MaxCommandAttemptsError,
    UnauthorizedError,
    UnknownCommandError,
} = require('../errors');
const { makeValidator } = require('../util');
const SnapshotRepository = require('./helpers/snapshot-repository-inmemory');
const NotificationHandler = require('./helpers/notification-handler-inmemory');
const libraryAggregate = require('./helpers/aggregates/library');
const { users, getAuthorizer } = require('./helpers/authorizer');

// An aggregate with some issues that we want to catch
const brokenCityAggregate = {
    projection: {
        initialState: cityId => ({ cityId }),
        applyEvent: (prevState, event) => {
            if (event.type === 'BAD_EVENT') {
                throw new EventPayloadError(event, 'iWillNeverExist');
            }
            return prevState;
        },
        validateState: () => {},
    },
    commands: {
        create: {
            isCreateCommand: true,
            validateParams: makeValidator(
                Joi.string()
                    .min(5)
                    .required(),
                'cityId',
            ),
            createEvent: cityId => ({
                type: 'CREATED',
                payload: { cityId },
            }),
        },
        generateEmptyEvent: {
            validateParams: () => {},
            createEvent: () => ({}),
        },
        generateBadEvent: {
            validateParams: () => {},
            createEvent: () => ({
                type: 'BAD_EVENT',
                payload: {},
            }),
        },
    },
};

const hebo = new Hebo({
    aggregates: {
        library: libraryAggregate,
        brokenCity: brokenCityAggregate,
    },
    defaultCommandRetries: 4,
});

const makeEventRepository = () =>
    new EventRepository({ aggregates: ['library', 'brokenCity'] });

const makeSnapshotRepository = () =>
    new SnapshotRepository({
        library: {},
        brokenCity: {},
    });

const setupTest = () => {
    const libraryId = shortid.generate();
    const eventRepository = makeEventRepository();
    const notificationHandler = new NotificationHandler();
    const snapshotRepository = makeSnapshotRepository();
    const authorizer = getAuthorizer(libraryId);

    const getAggregate = hebo.connect({
        eventRepository,
        snapshotRepository,
        notificationHandler,
        authorizer,
        user: users.superSally,
    });

    return {
        libraryId,
        getAggregate,
        eventRepository,
        notificationHandler,
    };
};

// Calling runCommand() with an unknown command should thrown an error.
test('unknown command', async t => {
    const { getAggregate } = await setupTest();

    await t.throws(
        getAggregate('library').runCommand('thisIsNotValid'),
        UnknownCommandError,
        'error thrown when runCommand called with unknown command name',
    );
});

// If the command's validateParams() call fails, an error should be thrown.
test('validateParams', async t => {
    const { getAggregate, libraryId, eventRepository } = await setupTest();

    // this should violate the 'name must be at least 4 chars' rule.
    await t.throws(
        getAggregate('library').runCommand('setName', libraryId, 'a'),
        InvalidCommandParamsError,
        'error thrown when validateParams fails',
    );

    t.deepEqual(
        await eventRepository.getEvents('library', libraryId),
        [],
        'no events written when validateParams fails',
    );
});

// You should not be able to run a create command if a aggregate already exists,
// and vice versa.
test('isCreateCommand', async t => {
    const { getAggregate, libraryId } = await setupTest();

    await t.throws(
        getAggregate('library').runCommand('setName', libraryId, 'North'),
        AggregateNotFoundError,
        'error thrown when non-create command run and aggregate does not exist',
    );

    await t.notThrows(
        getAggregate('library').runCommand('create', libraryId),
        'can run create command when aggregate does not exist',
    );

    await t.throws(
        getAggregate('library').runCommand('create', libraryId),
        DuplicateAggregateError,
        'error thrown when create command run and aggregate already exists',
    );
});

// If a command's createEvent() returns an invalid event, an error should be
// thrown.
test('createEvent generated invalid event', async t => {
    const { getAggregate } = await setupTest();

    const cityId = shortid.generate();

    await getAggregate('brokenCity').runCommand('create', cityId);

    // This should trigger an event that is missing any data, which should be
    // flagged as an invalid event.
    await t.throws(
        getAggregate('brokenCity').runCommand('generateEmptyEvent', cityId),
        InvalidEventError,
        'error thrown when command creates an invalid event',
    );
});

// If an aggregate's applyEvent() function throws an error when trying to apply
// a command's event, the error should be propogated.
test('applyEvent throws error', async t => {
    const { getAggregate, eventRepository } = await setupTest();

    const cityId = shortid.generate();

    await eventRepository.writeEvent('brokenCity', cityId, {
        eventId: shortid.generate(),
        type: 'CREATED',
        payload: { cityId },
        metadata: {
            user: users.superSally,
        },
        version: 1,
    });

    // This should trigger an event of type 'BAD_EVENT', which in turn
    // should trigger an error in the brokenCity aggregate's applyEvent().
    await t.throws(
        getAggregate('brokenCity').runCommand('generateBadEvent', cityId),
        EventPayloadError,
        'error thrown when command creates an event that fails at applyEvent',
    );
});

// If an aggregate's validateState() function throws an error after applying a
// command's event, the error should be propogated.
test('validateState throws error', async t => {
    const { getAggregate, eventRepository, libraryId } = await setupTest();

    await eventRepository.writeEvent('library', libraryId, {
        eventId: shortid.generate(),
        type: 'CREATED',
        payload: { libraryId },
        metadata: {
            user: users.superSally,
        },
        version: 1,
    });

    // This violate's the library's invariant that an active library must have a
    // name.
    await t.throws(
        getAggregate('library').runCommand('activate', libraryId),
        InvariantViolatedError,
        'error thrown when command creates an event that validateState rejects',
    );
});

// We should retry a command if the event repo's writeEvent() returns false.
// Test when a command does not have a specific retry number set - we should use
// our default retries.
test('retries - using defaultCommandRetries', async t => {
    const { getAggregate, eventRepository, libraryId } = await setupTest();

    await eventRepository.writeEvent('library', libraryId, {
        eventId: shortid.generate(),
        type: 'CREATED',
        payload: { libraryId },
        metadata: {
            user: users.superSally,
        },
        version: 1,
    });

    // Now setup event repo so that writes always fail
    const writeEvent = sinon.fake.resolves(false);
    sinon.replace(eventRepository, 'writeEvent', writeEvent);

    // Note: setCityName has no specific retries value, so we should use default
    await t.throws(
        getAggregate('library').runCommand('setCityName', libraryId, 'Encino'),
        MaxCommandAttemptsError,
        'error thrown when we reach max retries trying to write event',
    );

    t.is(writeEvent.callCount, 5, 'writeEvent() called 5 times');
});

// We should retry a command if the event repo's writeEvent() returns false.
// Test when a command has a specific retry number set that overrides the
// default.
test('retries - command specific setting', async t => {
    const { getAggregate, eventRepository, libraryId } = await setupTest();

    await eventRepository.writeEvent('library', libraryId, {
        eventId: shortid.generate(),
        type: 'CREATED',
        payload: { libraryId },
        metadata: {
            user: users.superSally,
        },
        version: 1,
    });

    // Now setup event repo so that writes always fail
    const writeEvent = sinon.fake.resolves(false);
    sinon.replace(eventRepository, 'writeEvent', writeEvent);

    // Note: setName has retries set to 3
    await t.throws(
        getAggregate('library').runCommand('setName', libraryId, 'North'),
        MaxCommandAttemptsError,
        'error thrown when we reach max retries trying to write event',
    );

    t.is(writeEvent.callCount, 4, 'writeEvent() called 4 times');
});

// A successful command should write events to our repository and generate the
// proper notifications.
test('successful command', async t => {
    const {
        getAggregate,
        eventRepository,
        notificationHandler,
        libraryId,
    } = await setupTest();

    await t.notThrows(
        getAggregate('library').runCommand('create', libraryId),
        'able to run create',
    );

    await t.notThrows(
        getAggregate('library').runCommand('setName', libraryId, 'North'),
        'able to run setName',
    );

    await t.notThrows(
        getAggregate('library').runCommand('setCityName', libraryId, 'Omaha'),
        'able to run setCityName',
    );

    const events = await eventRepository.getEvents('library', libraryId);

    t.is(events.length, 3, 'event generated for each command');

    const eventIds = events.map(e => e.eventId);
    const eventIdsSet = new Set(eventIds);
    t.is(eventIdsSet.size, 3, 'each generaged event gets unique eventId');

    t.deepEqual(
        events,
        [
            {
                eventId: eventIds[0],
                metadata: { user: users.superSally },
                version: 1,
                type: 'CREATED',
                payload: { libraryId },
            },
            {
                eventId: eventIds[1],
                metadata: { user: users.superSally },
                version: 2,
                type: 'NAME_SET',
                payload: { name: 'North' },
            },
            {
                eventId: eventIds[2],
                metadata: { user: users.superSally },
                version: 3,
                type: 'CITY_NAME_SET',
                payload: { name: 'Omaha' },
            },
        ],
        'correct events generated',
    );

    const notifications = notificationHandler.getNotifications();
    const expectedNotifications = [
        {
            name: 'eventWritten',
            notification: {
                aggregateName: 'library',
                aggregateId: libraryId,
                eventType: 'CREATED',
            },
        },
        {
            name: 'eventWritten',
            notification: {
                aggregateName: 'library',
                aggregateId: libraryId,
                eventType: 'NAME_SET',
            },
        },
        {
            name: 'eventWritten',
            notification: {
                aggregateName: 'library',
                aggregateId: libraryId,
                eventType: 'CITY_NAME_SET',
            },
        },
    ];

    t.deepEqual(
        notifications,
        expectedNotifications,
        'expected notifications generated',
    );
});

// Make sure a successful command works with a retry.
test('successful command, with retry', async t => {
    const {
        getAggregate,
        eventRepository,
        notificationHandler,
        libraryId,
    } = await setupTest();

    // Setup setup event repo so that it the first 2 writeEvent calls fail.
    const origWriteEvent = eventRepository.writeEvent;
    let numWriteAttempts = 0;
    const writeEvent = sinon.fake((...params) => {
        numWriteAttempts += 1;
        if (numWriteAttempts < 3) return Promise.resolve(false);
        return origWriteEvent(...params);
    });
    sinon.replace(eventRepository, 'writeEvent', writeEvent);

    await t.notThrows(
        getAggregate('library').runCommand('create', libraryId),
        'able to run create',
    );

    t.is(writeEvent.callCount, 3, 'writeEvent was retried');

    const events = await eventRepository.getEvents('library', libraryId);

    t.is(events.length, 1, 'event generated');
    t.deepEqual(
        events,
        [
            {
                eventId: events[0].eventId,
                metadata: { user: users.superSally },
                version: 1,
                type: 'CREATED',
                payload: { libraryId },
            },
        ],
        'correct event generated',
    );

    const notifications = notificationHandler.getNotifications();
    const expectedNotifications = [
        {
            name: 'eventWritten',
            notification: {
                aggregateName: 'library',
                aggregateId: libraryId,
                eventType: 'CREATED',
            },
        },
    ];

    t.deepEqual(
        notifications,
        expectedNotifications,
        'expected notifications generated',
    );
});

// Test that authorization is enforced.
test('authorization', async t => {
    const libraryId1 = shortid.generate();
    const libraryId2 = shortid.generate();
    const eventRepository = makeEventRepository();
    const notificationHandler = new NotificationHandler();
    const snapshotRepository = makeSnapshotRepository();
    const authorizer = getAuthorizer(libraryId1);

    const connect = user =>
        hebo.connect({
            eventRepository,
            snapshotRepository,
            notificationHandler,
            authorizer,
            user,
        });

    const getAggregateSally = connect(users.superSally);
    const getAggregateMary = connect(users.marySmith);
    const getAggregateJohn = connect(users.johnDoe);

    // marySmith had read-only privileges
    await t.throws(
        getAggregateMary('library').runCommand('create', libraryId1),
        UnauthorizedError,
        'error thrown when marySmith tries to run library create',
    );

    // johnDoe cannot run the create command on libraries
    await t.throws(
        getAggregateJohn('library').runCommand('create', libraryId1),
        UnauthorizedError,
        'error thrown when johnDoe tries to run library create',
    );

    // superSally can do anything
    await t.notThrows(
        getAggregateSally('library').runCommand('create', libraryId1),
        'superSally is allowed to run library create',
    );

    // johnDoe can set the library name on library1
    await t.notThrows(
        getAggregateJohn('library').runCommand('setName', libraryId1, 'Smith'),
        'johnDoe is allowed to run setName on the first library',
    );

    // Have superSally create a second library
    await t.notThrows(
        getAggregateSally('library').runCommand('create', libraryId2),
        'superSally is allowed to run library create',
    );

    // johnDoe is not allowed to set the library name on library2
    await t.throws(
        getAggregateJohn('library').runCommand('create', libraryId1),
        UnauthorizedError,
        'johnDoe is not allowed to run setName on the second library',
    );
});
