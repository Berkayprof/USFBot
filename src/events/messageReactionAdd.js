import report from '../commands/Utility/modules/report.js';
import { getGuildConfig } from '../services/config/guildConfig.js';

export default {
    name: 'messageReactionAdd',
    async execute(reaction, user, client) {
        if (user.bot) return;

        // Ophalen van partials voor oude berichten
        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch { return; }
        }

        if (reaction.emoji.name !== '🔴') return;

        const message = reaction.message;
        if (!message.guild) return;

        const config = await getGuildConfig(message.guild.id);

        // Hulpfunctie om terugkoppeling naar de melder via DM te sturen
        const sendDM = async (payload) => {
            try {
                const dm = await user.createDM();
                return await dm.send(payload);
            } catch {
                // Mislukt als de gebruiker DM's uit heeft staan
            }
        };

        // Uitgebreid nep-interaction object met alle vereiste velden voor discord.js helpers
        const mockInteraction = {
            id: message.id,
            createdTimestamp: Date.now(),
            guild: message.guild,
            guildId: message.guild.id,
            channel: message.channel,
            channelId: message.channel.id,
            user: user,
            member: await message.guild.members.fetch(user.id).catch(() => null),
            client: client,
            
            deferred: false,
            replied: false,
            isReplied: false,

            options: {
                getSubcommand: () => 'file',
                getUser: (name) => (name === 'user' ? message.author : null),
                getString: (name) => (name === 'reason' ? `Rapportage via 🔴 reactie op bericht: ${message.url}` : null),
            },

            inGuild: () => true,
            isChatInputCommand: () => true,
            isCommand: () => true,

            deferReply: async () => {
                mockInteraction.deferred = true;
                return Promise.resolve();
            },
            reply: async (payload) => {
                mockInteraction.replied = true;
                mockInteraction.isReplied = true;
                return await sendDM(payload);
            },
            editReply: async (payload) => {
                return await sendDM(payload);
            },
            followUp: async (payload) => {
                return await sendDM(payload);
            },
        };

        try {
            await report.execute(mockInteraction, config, client);
        } catch (error) {
            console.error('Fout bij uitvoeren van report via reactie:', error);
        }

        // Verwijder de reactie van de gebruiker
        try {
            await reaction.users.remove(user.id);
        } catch {
            // Negeer als de bot geen Manage Messages permissie heeft
        }
    },
};