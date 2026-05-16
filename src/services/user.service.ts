import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { NotionService } from './notion.service';
import { ChatService } from './chat.service';
import { logger } from '../utils/logger';
import type { UserRecord } from '../types/notion-model.types';

export class UserService {
  // Fallback in-memory storage for codes if Notion schema is missing the columns
  private memoryCodes = new Map<string, { code: string; expiry: Date }>();

  constructor(
    private notion: NotionService,
    private chatService: ChatService
  ) {}

  public async authenticate(email: string, password: string): Promise<UserRecord | null> {
    const user = await this.notion.findUserByEmail(email);
    if (!user) return null;

    // if mock mode or no password stored, allow only if password is empty or matches blank
    if (!user.passwordHash) return null;

    const match = await bcrypt.compare(password, user.passwordHash);
    return match ? user : null;
  }

  public createAccessToken(user: UserRecord) {
    const payload = { sub: user.pageId, email: user.email, role: user.role };
    const secret = env.JWT_ACCESS_SECRET || 'changeme';
    return jwt.sign(payload as any, secret as any, { expiresIn: env.ACCESS_TOKEN_TTL as any });
  }

  public async getUserById(userId: string): Promise<UserRecord | null> {
    return this.notion.findUserById(userId);
  }

  public async getLinkedPatientPageIds(userId: string): Promise<string[]> {
    return this.notion.getUserLinkedPatientIds(userId);
  }

  public async registerUser(input: {
    email: string;
    password: string;
    role: string;
    linkedPatientPageIds?: string[];
    name?: string; // Permitimos name para el nombre del paciente
  }): Promise<UserRecord> {
    const hashedPassword = await bcrypt.hash(input.password, 10);
    
    let patientIds = input.linkedPatientPageIds || [];

    // Auto-creamos un paciente en Notion para garantizar que el historial se guarde y sincronice
    if (patientIds.length === 0) {
      try {
        const patientPage = await this.notion.createPage({
          databaseId: env.DATABASE_ID_PACIENTES,
          properties: {
            Numero_Poliza: { title: [{ text: { content: `POL-${Date.now().toString().slice(-6)}` } }] },
            Nombre_Completo: { rich_text: [{ text: { content: input.name || input.email.split('@')[0] } }] },
            Email: { email: input.email },
          }
        });
        patientIds = [patientPage.id];
        logger.info(`Auto-created patient ${patientPage.id} for new user ${input.email}`);
      } catch (err: any) {
        logger.warn(`Failed to auto-create patient for user ${input.email}. Error: ${err.message}`);
      }
    }

    // Inspect database properties to build a compatible properties object
    const db = await this.notion.getDatabase(env.DATABASE_ID_USUARIOS);
    const dbProps: Record<string, any> = (db && db.properties) || {};

    const properties: Record<string, unknown> = {};

    // Email: prefer email type, fall back to title or rich_text
    if (dbProps.Email) {
      const t = dbProps.Email.type;
      if (t === 'email') properties.Email = { email: input.email };
      else if (t === 'title') properties.Email = { title: [{ text: { content: input.email } }] };
      else properties.Email = { rich_text: [{ text: { content: input.email } }] };
    }

    // Password_Hash: use rich_text if exists, otherwise create rich_text anyway
    if (dbProps.Password_Hash) {
      properties.Password_Hash = { rich_text: [{ text: { content: hashedPassword } }] };
    }

    // Role: try various property names that may exist
    const roleKey = Object.keys(dbProps).find((k) => k.toLowerCase() === 'rol' || k.toLowerCase() === 'role');
    if (roleKey) {
      const t = dbProps[roleKey].type;
      if (t === 'select' || t === 'multi_select') properties[roleKey] = { select: { name: input.role } };
      else properties[roleKey] = { rich_text: [{ text: { content: input.role } }] };
    }

    // Linked patients: find a relation property that matches patient keyword
    const patientKey = Object.keys(dbProps).find((k) => /pacient|paciente|patient/i.test(k));
    if (patientKey && patientIds.length) {
      if (dbProps[patientKey].type === 'relation') {
        properties[patientKey] = { relation: patientIds.map((id) => ({ id })) };
      }
    }

    const page = await this.notion.createPage({
      databaseId: env.DATABASE_ID_USUARIOS,
      properties,
    });

    return this.notion.mapUser(page);
  }

  public async updateProfile(userId: string, data: { name?: string; email?: string }): Promise<UserRecord | null> {
    const properties: Record<string, any> = {};
    if (data.email) {
      properties.Email = { title: [{ text: { content: data.email } }] };
    }
    // Note: In this schema, 'Name' might not exist in the users DB directly, 
    // but we can try to update it if it's there or update the linked patient.
    // For now, let's just update the user record properties that exist.
    
    const page = await this.notion.updatePage({
      pageId: userId,
      properties,
    });
    return this.notion.mapUser(page);
  }

  public async updatePassword(userId: string, newPassword: string): Promise<boolean> {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.notion.updatePage({
      pageId: userId,
      properties: {
        Password_Hash: { rich_text: [{ text: { content: hashedPassword } }] },
      },
    });
    return true;
  }

  public async deleteAccount(userId: string): Promise<void> {
    // 1. Buscamos los pacientes vinculados a este usuario
    const patientIds = await this.notion.getUserLinkedPatientIds(userId);
    
    // 2. Para cada paciente, borramos su historial completo
    for (const pid of patientIds) {
      const sessions = await this.notion.getConsultationsByNumeroPoliza(pid);
      for (const s of sessions) {
        await this.chatService.deleteSession(pid, s.pageId);
      }
      // 3. Archivamos el registro del paciente
      await this.notion.archivePage(pid);
    }
    
    // 4. Finalmente archivamos el registro del usuario
    await this.notion.archivePage(userId);
    
    logger.info(`User account ${userId} and all related data deleted.`);
  }

  public async generateVerificationCode(userId: string): Promise<string> {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDate = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    const expiry = expiryDate.toISOString();

    try {
      await this.notion.updatePage({
        pageId: userId,
        properties: {
          Reset_Code: { rich_text: [{ text: { content: code } }] },
          Reset_Code_Expiry: { rich_text: [{ text: { content: expiry } }] },
        },
      });
      logger.info(`Verification code saved in Notion for user ${userId}`);
    } catch (err: any) {
      // Fallback if Notion columns don't exist
      if (err.body?.includes('property that exists') || err.message?.includes('property that exists')) {
        logger.warn(`Notion schema missing 'Reset_Code' columns. Using memory fallback for user ${userId}`);
        this.memoryCodes.set(userId, { code, expiry: expiryDate });
      } else {
        throw err;
      }
    }

    return code;
  }

  public async verifyCode(userId: string, code: string): Promise<boolean> {
    // 1. Check memory fallback first
    const memRecord = this.memoryCodes.get(userId);
    if (memRecord) {
      if (new Date() > memRecord.expiry) {
        this.memoryCodes.delete(userId);
        return false;
      }
      if (memRecord.code === code) {
        this.memoryCodes.delete(userId);
        return true;
      }
      return false;
    }

    // 2. Check Notion if no memory record exists
    const user = await this.notion.findUserById(userId);
    if (!user) return false;

    const storedCode = (user.raw as any).Reset_Code?.rich_text?.[0]?.plain_text;
    const storedExpiry = (user.raw as any).Reset_Code_Expiry?.rich_text?.[0]?.plain_text;

    if (!storedCode || !storedExpiry) return false;
    if (storedCode !== code) return false;

    const isExpired = new Date() > new Date(storedExpiry);
    if (isExpired) return false;

    // Clear code after successful verification
    try {
      await this.notion.updatePage({
        pageId: userId,
        properties: {
          Reset_Code: { rich_text: [] },
          Reset_Code_Expiry: { rich_text: [] },
        },
      });
    } catch (err) {
      // ignore clear error on verification
    }

    return true;
  }
}

export default UserService;
