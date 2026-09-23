import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import { getWelcomeConfig, updateWelcomeConfig } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';

function createAutoroleInfoEmbed(description) {
    return new EmbedBuilder()
        .setColor(getColor('primary'))
        .setDescription(description)
        .setFooter({ text: new Date().toLocaleString() });
}

export default {
    data: new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('Manage roles that are automatically assigned to new members or bots')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Add an auto-assigned role for users or bots')
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('The role to auto-assign')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('target')
                        .setDescription('Who should receive this role? (Default: User)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'User / Member', value: 'user' },
                            { name: 'Bot', value: 'bot' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Remove an auto-assigned role')
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('The role to remove')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all auto-assigned roles')),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Autorole interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'autorole'
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/autorole`.' });
        }

        const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand === 'add') {
            const role = options.getRole('role');
            const target = options.getString('target') || 'user'; // 'user' or 'bot'

            const guildConfig = await getGuildConfig(client, guild.id);
            const verificationEnabled = Boolean(guildConfig.verification?.enabled);
            const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);

            // Restriction only applies to regular user roles when verification is active
            if (target === 'user' && (verificationEnabled || autoVerifyEnabled)) {
                return await replyUserError(interaction, { 
                    type: ErrorTypes.UNKNOWN, 
                    message: 'You cannot add a User AutoRole while the verification system or AutoVerify is enabled. Disable those first.' 
                });
            }

            if (role.position >= guild.members.me.roles.highest.position) {
                logger.warn(`[Autorole] User ${interaction.user.tag} tried to add role ${role.name} (${role.id}) higher than bot's highest role in ${guild.name}`);
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'I can\'t assign roles that are higher than my highest role.' });
            }

            try {
                const config = await getWelcomeConfig(client, guild.id);
                const fieldName = target === 'bot' ? 'botRoleIds' : 'roleIds';
                const existingRoles = config[fieldName] || [];
                const currentRoleId = existingRoles[0] || null;

                if (currentRoleId === role.id) {
                    logger.info(`[Autorole] Duplicate role ${role.name} (${role.id}) for target ${target} in ${guild.name}`);
                    return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `The role ${role} is already set as the auto-role for **${target}s**.` });
                }

                await updateWelcomeConfig(client, guild.id, {
                    [fieldName]: [role.id]
                });

                logger.info(`[Autorole] Set ${target} auto-role to ${role.name} (${role.id}) in ${guild.name} by ${interaction.user.tag}`);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createAutoroleInfoEmbed(
                        currentRoleId
                            ? `✅ **${target === 'bot' ? 'Bot' : 'User'}** auto-role updated to ${role}.`
                            : `✅ **${target === 'bot' ? 'Bot' : 'User'}** auto-role set to ${role}.`
                    )],
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                logger.error(`[Autorole] Failed to add role for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while adding the role. Please try again.' });
            }
        } 

        else if (subcommand === 'remove') {
            const role = options.getRole('role');

            try {
                const config = await getWelcomeConfig(client, guild.id);
                const userRoles = config.roleIds || [];
                const botRoles = config.botRoleIds || [];

                const isUserRole = userRoles.includes(role.id);
                const isBotRole = botRoles.includes(role.id);

                if (!isUserRole && !isBotRole) {
                    logger.info(`[Autorole] User ${interaction.user.tag} tried to remove non-configured role ${role.name} (${role.id}) in ${guild.name}`);
                    return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: `The role ${role} is not configured as an auto-role.` });
                }

                const updateData = {};
                if (isUserRole) updateData.roleIds = userRoles.filter(id => id !== role.id);
                if (isBotRole) updateData.botRoleIds = botRoles.filter(id => id !== role.id);

                await updateWelcomeConfig(client, guild.id, updateData);

                logger.info(`[Autorole] Removed role ${role.name} (${role.id}) from auto-assign in ${guild.name} by ${interaction.user.tag}`);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createAutoroleInfoEmbed(`✅ Removed ${role} from auto-assigned roles.`)],
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                logger.error(`[Autorole] Failed to remove role for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while removing the role. Please try again.' });
            }
        }

        else if (subcommand === 'list') {
            try {
                const guildConfig = await getGuildConfig(client, guild.id);
                const verificationEnabled = Boolean(guildConfig.verification?.enabled);
                const autoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);
                const conflictSummary = [
                    verificationEnabled ? 'Verification system is enabled' : null,
                    autoVerifyEnabled ? 'AutoVerify is enabled' : null
                ].filter(Boolean).join('\n');

                const config = await getWelcomeConfig(client, guild.id);
                const userRoleIds = Array.isArray(config.roleIds) ? config.roleIds : [];
                const botRoleIds = Array.isArray(config.botRoleIds) ? config.botRoleIds : [];

                const userRoleId = userRoleIds[0] || null;
                const botRoleId = botRoleIds[0] || null;

                const roles = await guild.roles.fetch();
                const userRole = userRoleId ? roles.get(userRoleId) : null;
                const botRole = botRoleId ? roles.get(botRoleId) : null;

                // Cleanup invalid role references if role was deleted from guild
                const updatePayload = {};
                if (userRoleId && !userRole) updatePayload.roleIds = [];
                if (botRoleId && !botRole) updatePayload.botRoleIds = [];

                if (Object.keys(updatePayload).length > 0) {
                    await updateWelcomeConfig(client, guild.id, updatePayload);
                }

                if (!userRole && !botRole) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [createAutoroleInfoEmbed(`ℹ️ No auto-roles are currently configured.${conflictSummary ? `\n\n⚠️ Setup blockers:\n${conflictSummary}` : ''}`)],
                        flags: MessageFlags.Ephemeral
                    });
                }

                const embed = new EmbedBuilder()
                    .setColor(getColor('info'))
                    .setTitle('Configured Auto-Roles')
                    .addFields(
                        { name: '👤 User Auto-Role', value: userRole ? `${userRole}` : 'None', inline: true },
                        { name: '🤖 Bot Auto-Role', value: botRole ? `${botRole}` : 'None', inline: true }
                    )
                    .setFooter({ text: 'One role per category allowed.' });

                if (conflictSummary) {
                    embed.setDescription(`⚠️ Setup blockers for users:\n${conflictSummary}`);
                }

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                logger.error(`[Autorole] Failed to list roles for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while listing auto-assigned roles. Please try again.' });
            }
        }
    },
};
