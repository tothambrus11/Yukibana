/** Asking before a submission is removed.
 *
 *  A removal cannot be undone: the row and the archive both go, and only
 *  the audit log keeps that there was one. So every remove button asks
 *  first, in the browser's own dialog, and a "no" stops the form. */

/** A form's `onsubmit` that cancels the submission unless the person
 *  confirms removing a submission for good. */
export function confirmRemoval(event: SubmitEvent): void {
    if (!confirm('Remove this submission for good? Its archive is deleted and cannot be restored.')) event.preventDefault();
}
