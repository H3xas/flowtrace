namespace Ferry.Api.Embark;

public interface IBadgeAccess
{
    Task<bool> AllowsAsync(int ticket);
}

public class BadgeStep : IEmbarkStep
{
    private readonly IBadgeAccess _access;

    public BadgeStep(IBadgeAccess access)
    {
        _access = access;
    }

    public bool ShouldExecute(EmbarkRequest request)
    {
        return request.Badge;
    }

    public async Task ProcessAsync(EmbarkRequest request)
    {
        request.Valid = await _access.AllowsAsync(request.Ticket);
    }
}

public class DeckStep : IEmbarkStep
{
    public bool ShouldExecute(EmbarkRequest request)
    {
        return request.Deck > 0;
    }

    public async Task ProcessAsync(EmbarkRequest request)
    {
        if (request.Deck > 9) throw new DeckFullException();
        await Task.CompletedTask;
    }
}

public class DeckFullException : Exception
{
}
