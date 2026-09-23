import {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { getDefaultApplicationQuestions } from '../config/bot.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { handleInteractionError, createError, ErrorTypes, replyUserError } from '../utils/errorHandler.js';
import ApplicationService, { getApplicationStatusPresentation } from '../services/applicationService.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { logEvent, EVENT_TYPES, resolveApplicationLogChannel } from '../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../utils/logging/logEmbeds.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
    getApplicationSettings,
    getUserApplications,
    getApplication,
    getApplicationRoles,
    updateApplication,
    getApplicationRoleSettings,
} from '../utils/database.js';

const MAX_MODAL_QUESTIONS = 5;

async function resolveQuestions(client, guildId, roleId, settings) {
    let questions = settings.questions?.length ? settings.questions : getDefaultApplicationQuestions();
    const roleSettings = await getApplicationRoleSettings(client, guildId, roleId);
    if (roleSettings.questions && roleSettings.questions.length > 0) {
        questions = roleSettings.questions;
    }
    return questions.slice(0, MAX_MODAL_QUESTIONS);
}

/**
 * Button: app_apply:<roleId>
 * Opens the application form for the clicked application.
 */
export async function handleApplyButton(interaction, client, args = []) {
    if (!interaction.inGuild()) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This button can only be used in a server.' });
    }

    const roleId = args[0];
    const guildId = interaction.guild.id;

    const settings = await getApplicationSettings(client, guildId);
    if (!settings.enabled) {
        throw createError(
            'Applications are disabled',
            ErrorTypes.CONFIGURATION,
            'Applications are currently disabled in this server.',
            { guildId },
        );
    }

    const applicationRoles = await getApplicationRoles(client, guildId);
    const applicationRole = applicationRoles.find((appRole) => appRole.roleId === roleId);

    if (!applicationRole || applicationRole.enabled === false) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This application is no longer available.' });
    }

    const userApps = await getUserApplications(client, guildId, interaction.user.id);
    if (userApps.some((app) => app.status === 'pending')) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You already have a pending application. Please wait for it to be reviewed.' });
    }

    const role = interaction.guild.roles.cache.get(applicationRole.roleId);
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'The role for this application no longer exists.' });
    }

    const questions = await resolveQuestions(client, guildId, applicationRole.roleId, settings);

    const modal = new ModalBuilder()
        .setCustomId(`app_modal_${applicationRole.roleId}`)
        .setTitle(`Application for ${applicationRole.name}`.slice(0, 45));

    questions.forEach((question, index) => {
        const input = new TextInputBuilder()
            .setCustomId(`q${index}`)
            .setLabel(question.length > 45 ? `${question.substring(0, 42)}...` : question)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });

    await interaction.showModal(modal);
}

/**
 * Modal: app_modal_<roleId>
 * Stores the submitted application and posts it in the log channel with review buttons.
 */
export async function handleApplicationModal(interaction) {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith('app_modal_')) return;

    const roleId = interaction.customId.split('_')[2];
    const { client, guild } = interaction;

    await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });

    const applicationRoles = await getApplicationRoles(client, guild.id);
    const applicationRole = applicationRoles.find((appRole) => appRole.roleId === roleId);

    if (!applicationRole) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Application configuration not found.' });
    }

    const role = guild.roles.cache.get(roleId);
    if (!role) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'Role not found.' });
    }

    const settings = await getApplicationSettings(client, guild.id);
    const questions = await resolveQuestions(client, guild.id, roleId, settings);

    const answers = questions.map((question, i) => ({
        question,
        answer: interaction.fields.getTextInputValue(`q${i}`),
    }));

    try {
        const application = await ApplicationService.submitApplication(client, {
            guildId: guild.id,
            userId: interaction.user.id,
            roleId,
            roleName: applicationRole.name,
            username: interaction.user.tag,
            avatar: interaction.user.displayAvatarURL(),
            answers,
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [successEmbed(
                'Application Submitted',
                `Your application for **${applicationRole.name}** has been submitted successfully!\n\n` +
                `Application ID: \`${application.id}\`\n` +
                'You will receive a direct message when your application has been accepted or denied, ' +
                'so make sure your DMs are open for this server.',
            )],
            flags: ['Ephemeral'],
        });

        const roleSettings = await getApplicationRoleSettings(client, guild.id, roleId);
        const guildConfig = await getGuildConfig(client, guild.id);
        const logChannelId = resolveApplicationLogChannel(guildConfig, roleSettings, settings);

        if (logChannelId) {
            const logMessage = await logEvent({
                client,
                guildId: guild.id,
                eventType: EVENT_TYPES.APPLICATION_SUBMIT,
                channelId: logChannelId,
                data: {
                    title: 'Application Submitted',
                    lines: [
                        formatLogLine('Applicant', `<@${interaction.user.id}> (${interaction.user.tag})`),
                        formatLogLine('Application', applicationRole.name),
                        formatLogLine('Role', role.name),
                        formatLogLine('Application ID', `\`${application.id}\``),
                    ],
                    inlineFields: [
                        { name: 'Status', value: '🟡 In Progress', inline: true },
                    ],
                    author: await resolveUserAuthor(client, interaction.user.id),
                },
            });

            if (logMessage) {
                await logMessage.edit({
                    components: [ApplicationService.buildReviewButtons(application.id)],
                }).catch((error) => {
                    logger.warn('Failed to attach review buttons to application log message', {
                        error: error.message,
                        applicationId: application.id,
                    });
                });

                await updateApplication(client, guild.id, application.id, {
                    logMessageId: logMessage.id,
                    logChannelId,
                });
            }
        }
    } catch (error) {
        logger.error('Error creating application:', {
            error: error.message,
            userId: interaction.user.id,
            guildId: guild.id,
            roleId,
            stack: error.stack,
        });

        await handleInteractionError(interaction, error, {
            type: 'modal',
            handler: 'application_submission',
        });
    }
}

/**
 * Button: app_status
 * Shows the clicking user their own applications (ephemeral).
 */
export async function handleStatusButton(interaction, client) {
    if (!interaction.inGuild()) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This button can only be used in a server.' });
    }

    await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });

    const applications = await getUserApplications(client, interaction.guild.id, interaction.user.id);

    if (applications.length === 0) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'You have not submitted any applications yet.' });
    }

    const recent = applications
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 10);

    const embed = createEmbed({
        title: 'Your Applications',
        description: `Showing ${recent.length} recent application(s).`,
    });

    recent.forEach((application) => {
        const submittedAt = application?.createdAt ? new Date(application.createdAt) : null;
        const submittedAtDisplay = submittedAt && !Number.isNaN(submittedAt.getTime())
            ? submittedAt.toLocaleDateString()
            : 'Unknown date';
        const view = getApplicationStatusPresentation(application.status);

        embed.addFields({
            name: `${view.statusEmoji} ${application.roleName || 'Unknown Role'}`,
            value:
                `**Status:** ${view.statusLabel}\n` +
                `**Submitted:** ${submittedAtDisplay}\n` +
                `**ID:** \`${application.id}\``,
            inline: true,
        });
    });

    if (applications.length > recent.length) {
        embed.setFooter({ text: `Showing latest ${recent.length} of ${applications.length} applications.` });
    }

    return InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: ['Ephemeral'] });
}

/**
 * Button: app_decide:<approve|deny>:<applicationId>
 * Staff review buttons on the submission log message.
 */
export async function handleDecisionButton(interaction, client, args = []) {
    const [action, appId] = args;

    if (!interaction.inGuild() || !['approve', 'deny'].includes(action) || !appId) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This button is not valid.' });
    }

    const { guild } = interaction;
    const isApprove = action === 'approve';

    await ApplicationService.checkManagerPermission(client, guild.id, interaction.member);

    const application = await getApplication(client, guild.id, appId);
    if (!application) {
        await interaction.message.edit({ components: [] }).catch(() => {});
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This application no longer exists.' });
    }

    if (application.status !== 'pending') {
        await interaction.message.edit({ components: [] }).catch(() => {});
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This application has already been processed.' });
    }

    const modalId = `app_review_reason_${appId}_${action}`;
    const reasonModal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`${isApprove ? 'Approve' : 'Deny'} Application`);

    reasonModal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('review_reason')
                .setLabel('Reason (optional)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('This reason is included in the DM sent to the applicant.')
                .setMaxLength(500)
                .setRequired(false),
        ),
    );

    await interaction.showModal(reasonModal);

    const reasonSubmit = await interaction.awaitModalSubmit({
        time: 5 * 60 * 1000,
        filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
    }).catch(() => null);

    if (!reasonSubmit) return;

    await InteractionHelper.safeDefer(reasonSubmit, { flags: ['Ephemeral'] });

    const reason = reasonSubmit.fields.getTextInputValue('review_reason').trim() || 'No reason provided.';

    try {
        const result = await ApplicationService.finalizeReview(client, guild, application, {
            action,
            reason,
            reviewerId: reasonSubmit.user.id,
        });

        let body = `The application from <@${application.userId}> has been **${result.status}**.`;
        if (isApprove && !result.roleAssigned) {
            body += '\n⚠️ I could not assign the role automatically. Please check my permissions and role position.';
        }
        body += result.dmSent
            ? '\n📩 The applicant has been notified by DM.'
            : '\n⚠️ I could not DM the applicant (their DMs are probably closed).';

        await InteractionHelper.safeEditReply(reasonSubmit, {
            embeds: [successEmbed(`Application ${result.status}`, body)],
        });
    } catch (error) {
        logger.error('Error reviewing application via button:', {
            error: error.message,
            applicationId: appId,
            guildId: guild.id,
        });

        await handleInteractionError(reasonSubmit, error, {
            type: 'modal',
            handler: 'application_review',
        });
    }
}

/**
 * Button: app_view:<applicationId>
 * Lets staff read the answers of an application straight from the log message.
 */
export async function handleViewButton(interaction, client, args = []) {
    const [appId] = args;

    if (!interaction.inGuild() || !appId) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This button is not valid.' });
    }

    await ApplicationService.checkManagerPermission(client, interaction.guild.id, interaction.member);

    const application = await getApplication(client, interaction.guild.id, appId);
    if (!application) {
        return await replyUserError(interaction, { type: ErrorTypes.USER_INPUT, message: 'This application no longer exists.' });
    }

    const view = getApplicationStatusPresentation(application.status);
    const embed = createEmbed({
        title: `Application - ${application.roleName || 'Unknown Role'}`,
        description:
            `**Applicant:** <@${application.userId}>\n` +
            `**Status:** ${view.statusEmoji} ${view.statusLabel}\n` +
            `**Application ID:** \`${application.id}\``,
    });

    (application.answers || []).forEach((item, index) => {
        embed.addFields({
            name: `Q${index + 1}: ${String(item.question).slice(0, 240)}`,
            value: String(item.answer || '*No answer provided*').slice(0, 1024),
            inline: false,
        });
    });

    await interaction.reply({ embeds: [embed], flags: ['Ephemeral'] });
}
