const test = require('ava');
const { isFunction, omit } = require('lodash');
const shortid = require('shortid');
const EventRepository = require('hebo-event-repository-inmemory');
const SnapshotRepository = require('hebo-snapshot-repository-inmemory');
const NotificationHandler = require('hebo-notification-handler-inmemory');
const Hebo = require('..');
const {
    InvalidAggregateError,
    UnknownAggregateError,
} = require('hebo-validation');
const libraryAggregate = require('./helpers/aggregates/library');
const { users, getAuthorizer } = require('./helpers/authorizer');

test('constructor()', t => {
    const validParams = {
        aggregates: {
            library: libraryAggregate,
        },
    };

    t.notThrows(
        () => new Hebo(validParams),
        'can create Hebo with valid parameters',
    );

    t.throws(
        () => new Hebo(omit(validParams, 'aggregates')),
        /"aggregates" is required/,
        'aggregates required',
    );

    t.throws(
        () => new Hebo({ ...validParams, aggregates: { library: {} } }),
        InvalidAggregateError,
        'aggregates validation is run',
    );
});

test('connect() - parameters', t => {
    const hebo = new Hebo({
        aggregates: {
            library: libraryAggregate,
        },
    });

    const validParams = {
        eventRepository: new EventRepository({ aggregates: ['library'] }),
        snapshotRepository: new SnapshotRepository({ aggregates: ['library'] }),
        notificationHandler: new NotificationHandler(),
        authorizer: getAuthorizer(),
        user: users.superSally,
    };

    t.notThrows(
        () => hebo.connect(validParams),
        'connect() lives with valid parameters',
    );

    t.throws(
        () => hebo.connect(omit(validParams, 'eventRepository')),
        /"eventRepository" is required/,
        'connect() requires eventRepository',
    );

    t.throws(
        () => hebo.connect(omit(validParams, 'snapshotRepository')),
        /"snapshotRepository" is required/,
        'connect() requires snapshotRepository',
    );

    t.throws(
        () => hebo.connect(omit(validParams, 'notificationHandler')),
        /"notificationHandler" is required/,
        'connect() requires notificationHandler',
    );

    t.throws(
        () => hebo.connect(omit(validParams, 'authorizer')),
        /"authorizer" is required/,
        'connect() requires authorizer',
    );

    t.notThrows(
        () => hebo.connect(omit(validParams, 'user')),
        'connect() does not require user',
    );

    t.throws(
        () => hebo.connect({ ...validParams, eventRepository: {} }),
        /"getEvents" is required/,
        'connect() checks for valid eventRepository',
    );

    t.throws(
        () => hebo.connect({ ...validParams, snapshotRepository: {} }),
        /"getSnapshot" is required/,
        'connect() checks for valid snapshotRepository',
    );

    t.throws(
        () => hebo.connect({ ...validParams, notificationHandler: {} }),
        /"invalidEventsFound" is required/,
        'connect() checks for valid notificationHandler',
    );

    t.throws(
        () => hebo.connect({ ...validParams, authorizer: {} }),
        /"assert" is required/,
        'connect() checks for valid authorizer',
    );
});

test('connect() - results', async t => {
    const hebo = new Hebo({
        aggregates: {
            library: libraryAggregate,
        },
    });

    const { getAggregate, getProjection, updateSnapshot } = hebo.connect({
        eventRepository: new EventRepository({ aggregates: ['library'] }),
        snapshotRepository: new SnapshotRepository({ aggregates: ['library'] }),
        notificationHandler: new NotificationHandler(),
        authorizer: getAuthorizer(),
        user: users.superSally,
    });

    t.true(isFunction(getProjection), 'returns a getProjection() function');
    t.true(isFunction(updateSnapshot), 'returns an updateSnapshot() function');

    await t.throws(
        getProjection('players', shortid.generate()),
        UnknownAggregateError,
        'getProjection() throws correct error on unknown aggregate',
    );

    await t.throws(
        updateSnapshot('players', shortid.generate()),
        UnknownAggregateError,
        'updateSnapshot() throws correct error on unknown aggregate',
    );

    const libraryAggregateInstance = getAggregate('library');
    t.true(
        isFunction(libraryAggregateInstance.runCommand),
        'fetched aggregate instance has runCommand()',
    );
});
