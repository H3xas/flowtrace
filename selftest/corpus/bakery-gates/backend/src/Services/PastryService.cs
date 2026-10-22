using System.Collections.Generic;
using System.Threading.Tasks;
using Bakery.Gates.Models;

namespace Bakery.Gates.Services
{
    public interface IKitchenToggles
    {
        bool IsToggleEnabled(string toggle);
    }

    public class KitchenToggles : IKitchenToggles
    {
        public bool IsToggleEnabled(string toggle)
        {
            return toggle.Length > 0;
        }
    }

    public interface IPastryService
    {
        Task BakeAsync(PastryRequest request);
        Task<IReadOnlyList<string>> ListMenuAsync();
    }

    public interface IPastryRepository
    {
        Task InsertPastryAsync(PastryRequest request);
        Task<IReadOnlyList<string>> GetMenuAsync();
    }

    public class PastryService : IPastryService
    {
        private readonly IPastryRepository _pastries;

        public PastryService(IPastryRepository pastries)
        {
            _pastries = pastries;
        }

        public async Task BakeAsync(PastryRequest request)
        {
            await _pastries.InsertPastryAsync(request);
        }

        public async Task<IReadOnlyList<string>> ListMenuAsync()
        {
            return await _pastries.GetMenuAsync();
        }
    }

    public class PastryRepository : IPastryRepository
    {
        public Task InsertPastryAsync(PastryRequest request)
        {
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<string>> GetMenuAsync()
        {
            return Task.FromResult<IReadOnlyList<string>>(new List<string>());
        }
    }
}
