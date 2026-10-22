using System.Threading.Tasks;
using Bakery.Api.Models;

namespace Bakery.Api.Services
{
    public interface ITastingService
    {
        Task<bool> ApproveAsync(TastingRequest request);
        Task<bool> PreviewAsync(TastingRequest request);
    }

    public interface ITastingRepository
    {
        Task SaveTastingAsync(TastingRequest request);
    }

    public class TastingService : ITastingService
    {
        private readonly ITastingRepository _tastings;

        public TastingService(ITastingRepository tastings)
        {
            _tastings = tastings;
        }

        public async Task<bool> ApproveAsync(TastingRequest request)
        {
            if (!request.Certified) return false;
            await _tastings.SaveTastingAsync(request);
            return true;
        }

        public async Task<bool> PreviewAsync(TastingRequest request)
        {
            if (!request.Certified) return false;
            await Task.CompletedTask;
            return true;
        }
    }

    public class TastingRepository : ITastingRepository
    {
        public Task SaveTastingAsync(TastingRequest request)
        {
            return Task.CompletedTask;
        }
    }
}
