const shortid = require('shortid');
const { UnauthorizedError } = require('hebo-validation');

/*

We create 3 users with a corresponding authorizer function: a superuser, a user
that can read all libraries, and a user that can read/write on one library.

 */

const users = {
    // Super User
    superSally: {
        userId: shortid.generate(),
        email: 'sally@gmail.com',
    },

    // Will get read privileges on all libraries
    marySmith: {
        userId: shortid.generate(),
        email: 'msmith@gmail.com',
    },

    // Cannot create a library, but can do any other operation on the libraryId
    // passed to getAuthorizer.
    johnDoe: {
        userId: shortid.generate(),
        email: 'johndoe@gmail.com',
    },
};

const readOnlyOperations = new Set(['getProjection']);

const isAuthorized = ({ operation, user, libraryId }) => {
    switch (user.userId) {
        case users.superSally.userId:
            return true;
        case users.marySmith.userId:
            return (
                readOnlyOperations.has(operation.type) &&
                operation.aggregateName === 'library'
            );
        case users.johnDoe.userId: {
            const isCreateCommand =
                operation.type === 'runCommand' &&
                operation.aggregateName === 'library' &&
                operation.commandName === 'createLibrary';
            if (isCreateCommand) return false;
            return (
                operation.aggregateName === 'library' &&
                operation.aggregateId === libraryId
            );
        }
        default:
            return false;
    }
};

const assertAuthorized = ({ operation, user, libraryId }) => {
    return isAuthorized({ operation, user, libraryId })
        ? Promise.resolve()
        : Promise.reject(new UnauthorizedError(operation, user.email));
};

const getAuthorizer = libraryId => ({
    assert: (user, operation) =>
        assertAuthorized({ operation, user, libraryId }),
});

module.exports = {
    users,
    getAuthorizer,
};
