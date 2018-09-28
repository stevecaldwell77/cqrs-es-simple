const shortid = require('shortid');

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

    // Will get read/write privileges on the libraryId passed to getAuthorizer.
    johnDoe: {
        userId: shortid.generate(),
        email: 'johndoe@gmail.com',
    },
};

const isAuthorized = ({ operation, user, libraryId }) => {
    switch (user.userId) {
        case users.superSally.userId:
            return true;
        case users.marySmith.userId:
            return (
                operation.type === 'getProjection' &&
                operation.aggregateName === 'library'
            );
        case users.johnDoe.userId:
            return (
                operation.type === 'getProjection' &&
                operation.aggregateName === 'library' &&
                operation.aggregateId === libraryId
            );
        default:
            return false;
    }
};

const unauthError = ({ operation, user }) =>
    new Error(
        `user ${user.email} is not allowed to call ${operation.type} on ${
            operation.aggregateName
        } ${operation.aggregateId}`,
    );

const assertAuthorized = ({ operation, user, libraryId }) => {
    return isAuthorized({ operation, user, libraryId })
        ? Promise.resolve()
        : Promise.reject(unauthError({ operation, user, libraryId }));
};

const getAuthorizer = libraryId => ({
    assert: (user, operation) =>
        assertAuthorized({ operation, user, libraryId }),
});

module.exports = {
    users,
    getAuthorizer,
};
