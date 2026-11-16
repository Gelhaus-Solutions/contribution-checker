"use client";

import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { removeRepo } from "./actions";

/**
 * Remove deletes the repo's row and everything stored under it, so it is
 * confirmed first. A repo that only lost its App link is relinked instead.
 */
export function RemoveRepoButton(props: {
  projectId: string;
  repoId: string;
  fullName: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10"
        >
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent width="md">
        <DialogHeader>
          <DialogTitle>Remove {props.fullName}?</DialogTitle>
          <DialogDescription>
            Its staging settings, tracked release PR, PR checks and staging
            batches are deleted. Adding it again starts from nothing.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form action={removeRepo} className="flex justify-end gap-2">
            <input type="hidden" name="projectId" value={props.projectId} />
            <input type="hidden" name="repoId" value={props.repoId} />
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton size="sm" variant="destructive">
              Remove
            </SubmitButton>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
