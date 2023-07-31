import { useForm } from '@conform-to/react'
import { getFieldsetConstraint, parse } from '@conform-to/zod'
import { json, redirect, type DataFunctionArgs } from '@remix-run/node'
import {
	Form,
	Link,
	useActionData,
	useLoaderData,
	type V2_MetaFunction,
} from '@remix-run/react'
import { formatDistanceToNow } from 'date-fns'
import { z } from 'zod'
import { GeneralErrorBoundary } from '~/components/error-boundary.tsx'
import { floatingToolbarClassName } from '~/components/floating-toolbar.tsx'
import { ErrorList } from '~/components/forms.tsx'
import { Button } from '~/components/ui/button.tsx'
import { Icon } from '~/components/ui/icon.tsx'
import { StatusButton } from '~/components/ui/status-button.tsx'
import { getUserId, requireUserId } from '~/utils/auth.server.ts'
import { prisma } from '~/utils/db.server.ts'
import {
	getNoteImgSrc,
	invariantResponse,
	useIsSubmitting,
} from '~/utils/misc.tsx'
import { useOptionalUser } from '~/utils/user.ts'
import { type loader as notesLoader } from './notes.tsx'

export async function loader({ request, params }: DataFunctionArgs) {
	const userId = await getUserId(request)
	const note = await prisma.note.findUnique({
		where: { id: params.noteId },
		select: {
			id: true,
			title: true,
			content: true,
			ownerId: true,
			updatedAt: true,
			images: {
				select: {
					id: true,
					altText: true,
				},
			},
		},
	})

	invariantResponse(note, 'Not found', { status: 404 })

	const date = new Date(note.updatedAt)
	const timeAgo = formatDistanceToNow(date)

	// 💣 we no longer need to determine whether the user can delete here (we'll
	// do that in the UI), so you can remove this query entirely.
	const permission = userId
		? await prisma.permission.findFirst({
				select: { id: true },
				where: {
					roles: { some: { users: { some: { id: userId } } } },
					entity: 'note',
					action: 'delete',
					access: note.ownerId === userId ? { in: ['any', 'own'] } : 'any',
				},
		  })
		: null

	return json({
		note,
		timeAgo,
		// 💣 you can remove this, we'll do this check in the UI.
		canDelete: Boolean(permission),
	})
}

const DeleteFormSchema = z.object({
	intent: z.literal('delete-note'),
	noteId: z.string(),
})

export async function action({ request }: DataFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	const submission = parse(formData, {
		schema: DeleteFormSchema,
		acceptMultipleErrors: () => true,
	})
	if (submission.intent !== 'submit') {
		return json({ status: 'idle', submission } as const)
	}
	if (!submission.value) {
		return json({ status: 'error', submission } as const, { status: 400 })
	}

	const { noteId } = submission.value

	const note = await prisma.note.findFirst({
		select: { id: true, ownerId: true, owner: { select: { username: true } } },
		where: { id: noteId },
	})
	invariantResponse(note, 'Not found', { status: 404 })

	// 💣 you can remove everything between here and the next 💣
	const permission = await prisma.permission.findFirst({
		select: { id: true },
		where: {
			roles: { some: { users: { some: { id: userId } } } },
			entity: 'note',
			action: 'delete',
			access: note.ownerId === userId ? { in: ['any', 'own'] } : 'any',
		},
	})

	if (!permission) {
		throw json(
			{
				error: 'Unauthorized',
				message: `Unauthorized: requires permission delete:note`,
			},
			{ status: 403 },
		)
	}
	// 💣 you can remove everything between here and the previous 💣
	// 🐨 use the `requireUserWithPermission`

	await prisma.note.delete({ where: { id: note.id } })

	return redirect(`/users/${note.owner.username}/notes`)
}

export default function NoteRoute() {
	const data = useLoaderData<typeof loader>()
	const user = useOptionalUser()
	const isOwner = user?.id === data.note.ownerId
	// 🐨 we no longer are using the loader to determine whether the user has
	// permission to delete. We load all the user's permissions in the root loader
	// and can use the userHasPermission utility. Use that here:
	const canDelete = data.canDelete
	const displayBar = canDelete || isOwner

	return (
		<div className="absolute inset-0 flex flex-col px-10">
			<h2 className="mb-2 pt-12 text-h2 lg:mb-6">{data.note.title}</h2>
			<div className={`${displayBar ? 'pb-24' : 'pb-12'} overflow-y-auto`}>
				<ul className="flex flex-wrap gap-5 py-5">
					{data.note.images.map(image => (
						<li key={image.id}>
							<a href={getNoteImgSrc(image.id)}>
								<img
									src={getNoteImgSrc(image.id)}
									alt={image.altText ?? ''}
									className="h-32 w-32 rounded-lg object-cover"
								/>
							</a>
						</li>
					))}
				</ul>
				<p className="whitespace-break-spaces text-sm md:text-lg">
					{data.note.content}
				</p>
			</div>
			{displayBar ? (
				<div className={floatingToolbarClassName}>
					<span className="text-sm text-foreground/90 max-[524px]:hidden">
						<Icon name="clock" className="scale-125">
							{data.timeAgo} ago
						</Icon>
					</span>
					<div className="grid flex-1 grid-cols-2 justify-end gap-2 min-[525px]:flex md:gap-4">
						{canDelete ? <DeleteNote id={data.note.id} /> : null}
						<Button
							asChild
							className="min-[525px]:max-md:aspect-square min-[525px]:max-md:px-0"
						>
							<Link to="edit">
								<Icon name="pencil-1" className="scale-125 max-md:scale-150">
									<span className="max-md:hidden">Edit</span>
								</Icon>
							</Link>
						</Button>
					</div>
				</div>
			) : null}
		</div>
	)
}

export function DeleteNote({ id }: { id: string }) {
	const actionData = useActionData<typeof action>()
	const isSubmitting = useIsSubmitting()
	const [form] = useForm({
		id: 'delete-note',
		lastSubmission: actionData?.submission,
		constraint: getFieldsetConstraint(DeleteFormSchema),
		onValidate({ formData }) {
			return parse(formData, { schema: DeleteFormSchema })
		},
	})

	return (
		<Form method="post" {...form.props}>
			<input type="hidden" name="noteId" value={id} />
			<StatusButton
				type="submit"
				name="intent"
				value="delete-note"
				variant="destructive"
				status={isSubmitting ? 'pending' : actionData?.status ?? 'idle'}
				disabled={isSubmitting}
				className="w-full max-md:aspect-square max-md:px-0"
			>
				<Icon name="trash" className="scale-125 max-md:scale-150">
					<span className="max-md:hidden">Delete</span>
				</Icon>
			</StatusButton>
			<ErrorList errors={form.errors} id={form.errorId} />
		</Form>
	)
}

export const meta: V2_MetaFunction<
	typeof loader,
	{ 'routes/users+/$username_+/notes': typeof notesLoader }
> = ({ data, params, matches }) => {
	const notesMatch = matches.find(
		m => m.id === 'routes/users+/$username_+/notes',
	)
	const displayName = notesMatch?.data?.owner.name ?? params.username
	const noteTitle = data?.note.title ?? 'Note'
	const noteContentsSummary =
		data && data.note.content.length > 100
			? data?.note.content.slice(0, 97) + '...'
			: 'No content'
	return [
		{ title: `${noteTitle} | ${displayName}'s Notes | Epic Notes` },
		{
			name: 'description',
			content: noteContentsSummary,
		},
	]
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				403: () => <p>You are not allowed to do that</p>,
				404: ({ params }) => (
					<p>No note with the id "{params.noteId}" exists</p>
				),
			}}
		/>
	)
}
