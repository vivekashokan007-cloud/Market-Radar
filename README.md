# How to Push a Project to GitHub

This guide explains how to upload your local project to GitHub using
Git.

## 1. Install Git

Download and install Git from: https://git-scm.com/downloads

After installation, verify it:

    git --version

## 2. Create a Repository on GitHub

1.  Go to https://github.com
2.  Click **New Repository**
3.  Enter a repository name
4.  Click **Create repository**

## 3. Initialize Git in Your Project

Open terminal or command prompt in your project folder.

    git init

## 4. Add Project Files

    git add .

## 5. Commit Your Code

    git commit -m "Initial commit"

## 6. Connect Your GitHub Repository

Replace USERNAME and REPOSITORY_NAME with your GitHub details.

    git remote add origin https://github.com/USERNAME/REPOSITORY_NAME.git

## 7. Push Code to GitHub

    git branch -M main
    git push -u origin main

## 8. Update Code Later

    git add .
    git commit -m "Update project"
    git push

## Useful Commands

Check repository status:

    git status

See commit history:

    git log
