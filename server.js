/*
* todo
*  Users should be able to disconnect their Discord account from their WordPress account
*  When a user disconnects, this should be persisted to the discordIdWpIdMapping cache to allow users to reconnect with another Discord account */

const mysql = require('promise-mysql');
const {Client} = require('discord.js');

const production = true;

const environment = {
    dev: {
        envName: 'development',
        guildId: '',
        discordAdminRoleId: '',
        discordPremiumMemberRoleId: '',
        checkIntervalInMs: 5000,
        discordBotToken: '',
        botLogChannelId: '',
        dbConfig: {
            host: '',
            user: '',
            password: '',
            database: '',
            connectionLimit: 10
        }
    },
    prod: {
        envName: 'production',
        guildId: '',
        discordAdminRoleId: '',
        discordPremiumMemberRoleId: '',
        checkIntervalInMs: 60000,
        discordBotToken: '',
        botLogChannelId: '',
        dbConfig: {
            host: '',
            user: '',
            password: '',
            database: '',
            connectionLimit: 10
        }
    }
};

environment.current = production ? environment.prod : environment.dev;

(async () => {
    log(`*** Starting Stocktrades.ca Discord bot - ${environment.current.envName} environment`);
    log(`*** Premium member check interval set to ${environment.current.checkIntervalInMs}ms`);
    const dbConnection = await mysql.createPool(environment.current.dbConfig);
    log(`*** Connected to WordPress database`);
    let premiumMemberWpIds = await fetchPremiumMemberWpIds();

    async function fetchPremiumMemberWpIds() {
        const records = await dbConnection.query("SELECT * FROM wp_usermeta WHERE meta_key = 'wp_capabilities'");
        const premiumMemberFilter = record => record['meta_value'].includes('s:10:"paidmember"') || record['meta_value'].includes('s:13:"bbp_keymaster"') || record['meta_value'].includes('s:13:"administrator"');
        return records
            .filter(premiumMemberFilter)
            .map(record => record['user_id']);
    }

    async function getWpIdForUser(discordId) {
        log(`Fetching WordPress ID for Discord ID: ${discordId}`);
        const cacheResult = discordIdWpIdMapping[discordId];
        if (cacheResult) {
            log(`Found in cache. WordPress ID: ${cacheResult}`);
            return cacheResult;
        } else {
            const wpId = await getWpIdFromDatabase();
            if (wpId) {
                discordIdWpIdMapping[discordId] = wpId;
                log(`Queried database. WordPress ID: ${wpId}`);
            } else {
                log(`Queried database. No WordPress ID for this Discord ID found.`);
            }
            return wpId;
        }

        async function getWpIdFromDatabase() {
            const records = await dbConnection.query(`SELECT user_id FROM wp_usermeta WHERE meta_key = 'DiscordId' AND meta_value = '${discordId}'`);
            if (!records || records.length === 0) {
                return false;
            } else {
                return records[0]['user_id'];
            }
        }
    }

    async function getWpStateForDiscordUser(member) {
        const discordId = member.user.id;
        const wpId = await getWpIdForUser(discordId);

        if (!wpId) {
            return {isPremium: false, isCoupled: false};
        } else {
            return {isPremium: premiumMemberWpIds.includes(wpId), isCoupled: true};
        }
    }

    async function kickMember(member, isCoupled) {
        log(`Kicked ${member.user.username}`, true);
        if (!isCoupled) {
            log(`Member ${member.user.username} is not coupled to WP, kicking.`);
        } else {
            log(`Member ${member.user.username} is coupled to WP but not premium, kicking.`);
        }
        await member.kick();
    }

    async function handleNewDiscordMember(discordMember) {
        {
            log(`New member joined Discord: ${discordMember.user.username}.`);
            const wpState = await getWpStateForDiscordUser(discordMember);
            if (!wpState.isPremium) {
                await kickMember(discordMember, wpState.isCoupled);
            } else {
                await discordMember.roles.add(environment.current.discordPremiumMemberRoleId);
                log(`Role Premium Member given to new user ${discordMember.user.username}.`);
            }
        }
    }

    async function verifyAllDiscordMembersArePremium() {
        log(`Verifying all Discord members are premium`)
        premiumMemberWpIds = await fetchPremiumMemberWpIds();
        log(`Fetched list of premium members (${premiumMemberWpIds.length}) from WordPress`);
        const discordGuildMembers = await discordGuild.members.fetch();
        log(`Fetched list of Discord members (${discordGuildMembers.size})`);
        let botOrAdminCount = 0;
        let premiumCount = 0;
        let kickedCount = 0;
        for (const member of discordGuildMembers.values()) {
            const isBot = member.user.bot;
            const isAdmin = member.roles.cache.find(role => role.id === environment.current.discordAdminRoleId);
            if (!isBot && !isAdmin) {
                const wpState = await getWpStateForDiscordUser(member);
                if (!wpState.isPremium) {
                    kickedCount++;
                    await kickMember(member, wpState.isCoupled);
                } else {
                    premiumCount++;
                }
            } else {
                botOrAdminCount++;
            }
        }
        log(`Kicked ${kickedCount} free members`);
        log(`${premiumCount} premium members and ${botOrAdminCount} bot/admin accounts left`);
    }

    function log(content, logToDiscord) {
        if (!logToDiscord) {
            console.log(`${new Date().toLocaleString()} - ${content}`);
        } else {
            if (botLogChannel) {
                botLogChannel.send(content);
            }
        }
    }

    const discordClient = new Client();
    let discordGuild;
    let botLogChannel;
    const discordIdWpIdMapping = {};

    discordClient.on('guildMemberAdd', handleNewDiscordMember);

    discordClient.on('ready', async () => {
        log(`*** Connected to Discord`);
        discordGuild = await discordClient.guilds.fetch(environment.current.guildId);
        botLogChannel = await discordClient.channels.fetch(environment.current.botLogChannelId);
        log(`Started up bot in ${environment.current.envName} environment; connected to WordPress database`, true);
        setInterval(verifyAllDiscordMembersArePremium, environment.current.checkIntervalInMs)
    });

    await discordClient.login(environment.current.discordBotToken);
})();
