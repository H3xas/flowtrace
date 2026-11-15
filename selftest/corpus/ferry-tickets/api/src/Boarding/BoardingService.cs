namespace Ferry.Api.Boarding;

public interface IBoardingService
{
    Task<bool> ApproveAsync(int ticket);
    Task<Pass> FindPassAsync(int ticket);
}

public class BoardingService : IBoardingService
{
    public async Task<bool> ApproveAsync(int ticket)
    {
        if (ticket <= 0) return false;
        await Task.CompletedTask;
        return true;
    }

    public async Task<Pass> FindPassAsync(int ticket)
    {
        if (ticket <= 0) return null;
        await Task.CompletedTask;
        return new Pass();
    }
}

public class Pass
{
}
