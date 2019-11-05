// @ts-check

const fileSystem = require('fs').promises;
const matrixSdk = require('matrix-js-sdk');
const {
    getParsedRooms,
    getMatrixAlias,
    getBaseUrl,
    getUserId,
    getRoomsLastUpdate,
    isEnglish,
    SLICE_AMOUNT,
    timing,
} = require('./utils');
const Listr = require('listr');
const chalk = require('chalk');
const delay = require('delay');
const path = require('path');
// eslint-disable-next-line
const { MatrixClient } = require('matrix-js-sdk');

const spinLoginText = 'login with password';
const spinSyncText = 'wait for sync with matrix server\n';

module.exports = class {
    /**
     * @param {object} sdk sdk client
     */
    constructor({
        sdk,
        domain,
        userName,
        password,
        sliceAmount,
        delayTime,
        fs = fileSystem,
        logger = console,
        eventsCount,
    }) {
        this.logger = logger;
        this.sdk = sdk || matrixSdk;
        this.userName = userName;
        this.domain = domain;
        this.matrixUserId = getUserId(userName, domain);
        this.password = password;
        this.client;
        this.sliceAmount = sliceAmount || SLICE_AMOUNT;
        this.delayTime = delayTime || 500;
        this.fs = fs;
        this.eventsCount = eventsCount;
    }

    /**
     * @param {object} client matrix client
     * @return {Promise<MatrixClient>} promise with resolve after connection
     */
    _getReadyClient(client) {
        return new Promise((resolve, reject) => {
            client.on('sync', state => {
                if (state === 'SYNCING') {
                    resolve(client);
                }
            });
        });
    }

    /**
     *
     */
    _shouldJoin() {
        this.client.on('RoomMember.membership', async (event, member) => {
            if (member.membership === 'invite' && member.userId === this.getMatrixFormatUserId(this.userName)) {
                try {
                    await this.client.joinRoom(member.roomId);
                    this.logger.info(`${this.userId} joined to room with id = ${member.roomId}`);
                } catch (error) {
                    this.logger.error(`Error joining to room with id = ${member.roomId}`);
                }
            }
        });
    }

    /**
     * @param {any} data data to save
     * @param {string} name name alias
     * Save leaved to file
     */
    async saveToJson(data, name) {
        const fileName = `${name}_${Date.now()}.json`;
        const filePath = path.resolve(__dirname, fileName);
        await this.fs.writeFile(filePath, JSON.stringify(data), 'utf8');

        return filePath;
    }

    /**
     * @param {string} name user name
     * @return {string} matrix format user id
     */
    getMatrixFormatUserId(name) {
        return getUserId(name, this.domain);
    }

    /**
     * Get matrix sync client
     */
    async getClient() {
        const tasks = new Listr([
            {
                title: spinLoginText,
                task: async ctx => {
                    const baseUrl = getBaseUrl(this.domain);
                    const userId = this.getMatrixFormatUserId(this.userName);
                    const client = this.sdk.createClient(baseUrl);
                    const { access_token: accessToken } = await client.loginWithPassword(userId, this.password);
                    const matrixClient = this.sdk.createClient({
                        baseUrl,
                        accessToken,
                        userId,
                    });
                    ctx.matrixClient = matrixClient;
                },
            },
            {
                title: spinSyncText,
                task: async ctx => {
                    await ctx.matrixClient.startClient({
                        initialSyncLimit: this.eventsCount,
                        disablePresence: true,
                    });
                    const readyClient = await this._getReadyClient(ctx.matrixClient);
                    // eslint-disable-next-line
                    ctx.matrixClient = readyClient;
                },
            },
        ]);
        const startTime = Date.now();

        const { matrixClient } = await tasks.run();
        this.client = matrixClient;
        const { min, sec } = timing(startTime);
        this.logger.info(chalk.green(`\nMatrix user have connected on ${min} min ${sec} sec\n`));

        return matrixClient;
    }

    /**
     * @param {Object} room matrix room
     * @return {Boolean} return true if room is chat
     */
    _isChat(room) {
        const allMembers = room.getJoinedMembers();
        return allMembers.length < 3 && !isEnglish(room.name);
    }

    /**
     * @param {Object} room matrix room
     * @return {Boolean} is only user in romm
     */
    async _isSingle(room) {}

    /**
     * @typedef {Object} Room
     * @property {string} project
     * @property {string} roomId
     * @property {string} roomName
     * @property {string[]} members
     * @property {{author: string, date: string}[]} message
     */

    /**
     * @return {Promise<{allRooms: Room[], singleRoomsManyMessages: Room[], singleRoomsNoMessages: Room[], manyMembersNoMessages: Room[], manyMembersManyMessages: Room[]}>} matrix rooms
     */
    async getAllRoomsInfo() {
        const matrixClient = this.client || (await this.getClient());
        const rooms = await matrixClient.getRooms();
        const parsedRooms = rooms.map(getParsedRooms);

        const singleRoomsNoMessages = parsedRooms.filter(room => {
            return room.members.length === 1 && room.messages.length === 0;
        });

        const singleRoomsManyMessages = parsedRooms.filter(room => {
            return room.members.length === 1 && room.messages.length;
        });

        const manyMembersNoMessages = parsedRooms.filter(room => {
            return room.members.length > 1 && room.messages.length === 0;
        });

        const manyMembersManyMessages = parsedRooms.filter(room => {
            return room.members.length > 1 && room.messages.length;
        });
        // await this._saveRoomsToJson(parsedRooms);

        return {
            allRooms: parsedRooms,
            singleRoomsManyMessages,
            singleRoomsNoMessages,
            manyMembersNoMessages,
            manyMembersManyMessages,
        };
    }

    /**
     *
     * @param {string} roomId matrix roomId
     * @param {string} userId matrix userId
     * @param {number} level level, by default is 100
     */
    async setPowerLevel(roomId, userId, level = 100) {
        const client = this.client || (await this.getClient());

        const content = await client.getStateEvent(roomId, 'm.room.power_levels', '');
        const event = {
            getType: () => 'm.room.power_levels',
            getContent: () => content,
        };

        await client.setPowerLevel(roomId, userId, level, event);
        return true;
    }

    /**
     * @param {{ roomId: string, roomName: string }[]} rooms matrix rooms from getRooms
     * @param {string} matrixUserId matrix user
     * @param {string?} level level to update
     * @return {Promise<{poweredRooms: { roomId: string, roomName: string }[], errPoweredRooms: { roomId: string, roomName: string }[], errors: object[]}>} errors and powered rooms
     */
    async setPower(rooms, matrixUserId, level) {
        const poweredRooms = [];
        const errPoweredRooms = [];

        const iter = async (rooms = [], errors = []) => {
            if (!rooms.length) {
                return { errors, poweredRooms, errPoweredRooms };
            }

            // eslint-disable-next-line
            console.clear();
            this.logger.log(`Powered: ${chalk.green(poweredRooms.length)} Left: ${chalk.yellow(rooms.length)}`);
            const roomsToHandle = rooms.slice(0, this.sliceAmount);
            const restRooms = rooms.slice(this.sliceAmount);
            try {
                const preparedTasks = roomsToHandle.map(({ roomId, roomName }) => {
                    const title = `Powering room ${chalk.cyan(roomName)} for user ${chalk.cyan(matrixUserId)}`;
                    const task = async () => {
                        try {
                            await delay(this.delayTime);
                            await this.setPowerLevel(roomId, matrixUserId, level);
                            poweredRooms.push({ roomId, roomName });
                        } catch (error) {
                            errPoweredRooms.push({ roomId, roomName });
                            throw error;
                        }
                    };

                    return {
                        title,
                        task,
                    };
                });
                const tasks = new Listr(preparedTasks, {
                    exitOnError: false,
                });

                await tasks.run();

                return iter(restRooms, errors);
            } catch (err) {
                return iter(restRooms, [...errors, ...err.errors]);
            }
        };

        return iter(rooms);
    }

    /**
     * @return {Promise<array>} matrix rooms
     */
    async noMessagesEmptyRooms() {
        const { singleRoomsNoMessages } = await this.getAllRoomsInfo();

        return singleRoomsNoMessages;
    }

    /**
     * @param {number|undefined} limit timestamp limit date
     * @param {array|string|undefined} users users to ignore in events
     */
    async getRooms(limit, users = []) {
        const ignoreUsers = typeof users === 'string' ? [users] : users;
        const matrixClient = this.client || (await this.getClient());
        const rooms = await matrixClient.getRooms();
        const filteredRooms = rooms.filter(room => !this._isChat(room));

        return getRoomsLastUpdate(filteredRooms, limit, ignoreUsers);
    }

    /**
     * @param {{ roomId: string, roomName: string }[]} allRooms matrix rooms from getRooms
     * @return {Promise<{leavedRooms: { roomId: string, roomName: string }[], errLeavedRooms: { roomId: string, roomName: string }[], errors: object[]}>} errors and leaved rooms empty array
     */
    async leaveRooms(allRooms) {
        const client = this.client || (await this.getClient());
        const leavedRooms = [];
        const errLeavedRooms = [];

        const iter = async (rooms = [], errors = []) => {
            if (!rooms.length) {
                return { errors, leavedRooms, errLeavedRooms };
            }

            // eslint-disable-next-line
            console.clear();
            this.logger.log(
                `Left: ${chalk.yellow(rooms.length)} Complited: ${chalk.green(leavedRooms.length)} Error: ${chalk.red(
                    errLeavedRooms.length,
                )}`,
            );
            const roomsToHandle = rooms.slice(0, this.sliceAmount);
            const restRooms = rooms.slice(this.sliceAmount);
            try {
                const preparedTasks = roomsToHandle.map(({ roomId, roomName }) => {
                    const title = `Leaving room ${chalk.cyan(roomName)}`;
                    const task = async () => {
                        try {
                            await delay(this.delayTime);
                            await client.leave(roomId);
                            leavedRooms.push({ roomId, roomName });
                        } catch (error) {
                            errLeavedRooms.push({ roomId, roomName });
                            throw error;
                        }
                    };

                    return {
                        title,
                        task,
                    };
                });
                const tasks = new Listr(preparedTasks, {
                    exitOnError: false,
                });

                await tasks.run();

                return iter(restRooms, errors);
            } catch (err) {
                return iter(restRooms, [...errors, ...err.errors]);
            }
        };

        return iter(allRooms);
    }

    /**
     * Get matrix room id by alias
     * @param  {string} name matrix room alias
     */
    async getRoomByAlias(name) {
        const matrixClient = this.client || (await this.getClient());
        try {
            const alias = getMatrixAlias(name, this.domain);
            const { room_id: roomId } = await matrixClient.getRoomIdForAlias(alias);

            return roomId;
        } catch {
            return;
        }
    }

    /**
     *
     * @param {string} roomName
     */
    async getRoomByName(roomName) {
        const { allRooms } = await this.getAllRoomsInfo();

        return allRooms.filter(item => item.roomName.includes(roomName));
    }

    /**
     *
     * @param {array} allRooms matrix rooms of user
     * @param {string} userId matrix userId
     * @return {Promise<{invitedRooms: { roomId: string, roomName: string }[], errInvitedRooms: { roomId: string, roomName: string }[], errors: object[]}>} errors and leaved rooms empty array
     */
    async inviteUserToRooms(allRooms, userId) {
        const client = this.client || (await this.getClient());
        const invitedRooms = [];
        const errInvitedRooms = [];

        const iter = async (rooms = [], errors = []) => {
            if (!rooms.length) {
                return { errors, invitedRooms, errInvitedRooms };
            }

            // eslint-disable-next-line
            console.clear();
            const roomsToHandle = rooms.slice(0, this.sliceAmount);
            const restRooms = rooms.slice(this.sliceAmount);
            try {
                const preparedTasks = roomsToHandle.map(({ roomId, roomName }) => {
                    const title = `Inviting user ${chalk.cyan(userId)} to room ${chalk.cyan(roomName)}`;
                    const task = async () => {
                        try {
                            await delay(this.delayTime);
                            await client.invite(roomId, userId);
                            invitedRooms.push({ roomId, roomName });
                        } catch (error) {
                            errInvitedRooms.push({ roomId, roomName });
                            throw error;
                        }
                    };

                    return {
                        title,
                        task,
                    };
                });
                const tasks = new Listr(preparedTasks, {
                    exitOnError: false,
                });

                await tasks.run();

                return iter(restRooms, errors);
            } catch (err) {
                return iter(restRooms, [...errors, ...err.errors]);
            }
        };

        return iter(allRooms);
    }

    /** @type { roomId: string, roomName: string } ParsedRoom */

    /**
     *
     * @param {array} allRooms matrix rooms to join
     * @return {Promise<{joinedRooms: ParsedRoom[], errors: object[], errJoinedRooms: ParsedRoom[]}>} errors and leaved rooms empty array
     */
    async join(allRooms) {
        const client = this.client || (await this.getClient());
        const joinedRooms = [];
        const errJoinedRooms = [];

        const iter = async (rooms = [], errors = []) => {
            if (!rooms.length) {
                return { errors, joinedRooms, errJoinedRooms };
            }

            // eslint-disable-next-line
            console.clear();
            const roomsToHandle = rooms.slice(0, this.sliceAmount);
            const restRooms = rooms.slice(this.sliceAmount);
            try {
                const preparedTasks = roomsToHandle.map(({ roomId, roomName }) => {
                    const title = `Join user ${chalk.cyan(this.userName)} to room ${chalk.cyan(roomName)}`;
                    const task = async () => {
                        try {
                            await delay(this.delayTime);
                            await client.joinRoom(roomId);
                            joinedRooms.push({ roomId, roomName });
                        } catch (error) {
                            errJoinedRooms.push({ roomId, roomName });
                            throw error;
                        }
                    };

                    return {
                        title,
                        task,
                    };
                });
                const tasks = new Listr(preparedTasks, {
                    exitOnError: false,
                });

                await tasks.run();

                return iter(restRooms, errors);
            } catch (err) {
                return iter(restRooms, [...errors, ...err.errors]);
            }
        };

        return iter(allRooms);
    }

    /**
     * @param {string} name name matrix user
     */
    async getUser(name) {
        const client = this.client || (await this.getClient());
        const userId = getUserId(name, this.domain);

        return userId && client.getUser(userId);
    }

    /**
     */
    async getknownUsers() {
        const client = this.client || (await this.getClient());
        return client.getUsers();
    }

    /**
     * Send message
     * @param {array} rooms room id
     * @param {string} message message to send
     */
    async sendMessage(rooms, message) {
        const client = this.client || (await this.getClient());
        try {
            const preparedTasks = rooms.map(({ roomId, roomName }) => {
                const title = `Sending message ${chalk.cyan(message)} to room ${chalk.cyan(roomName)}`;
                const task = () => client.sendTextMessage(roomId, message);

                return {
                    title,
                    task,
                };
            });
            const tasks = new Listr(preparedTasks, {
                concurrent: true,
                exitOnError: false,
            });

            await tasks.run();
        } catch (err) {
            return err.errors;
        }
    }

    /**
     * Stop service
     */
    stop() {
        this.client && this.client.stopClient();
    }
};
